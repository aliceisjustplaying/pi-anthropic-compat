import {
  getCurrentSystemMessage,
  getCurrentTools,
  normalizeContext,
  type Message,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  convertToLlm,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { sendSummaryRequest, supportsCompaction } from "./client.ts";
import type { Config } from "./config.ts";
import { object, objects, type JsonObject } from "./json.ts";
import {
  CHECKPOINT_TYPE,
  COMPACTION_CANCELLED_CHANNEL,
  TEMPLATE_TYPE,
  checkpoint,
  eligibleModel,
  parseSummary,
  referencedTools,
  replay,
  summaryInstructions,
  summaryPayload,
  template,
  toolDefinitions,
} from "./protocol.ts";
import { PROMPT_FIRST_TYPE, promptFirst, promptFirstRecorded } from "./prompt-order.ts";
import { loadSessionConfig, registerSettings } from "./settings.ts";

// This fork never replaces the `anthropic` provider. Another extension (for example
// pi-black) may own it. Replay happens in `before_provider_request`, which Pi runs
// inside the provider's `onPayload` chain before provider-specific transforms and
// before the request body is serialized. Summary requests go through
// `ctx.modelRegistry.streamSimple`, so they pass through the registered provider too.

/**
 * Reject tool calls that still await a result. Pi never sends an errored or aborted response,
 * such as one the user interrupted while it streamed a tool call, so its tool calls never get a
 * result and are skipped here as well.
 */
export function requireCompletedTools(messages: readonly Message[]): void {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      if (message.stopReason === "error" || message.stopReason === "aborted") continue;
      for (const item of message.content) {
        if (item.type === "toolCall") pending.add(item.id);
      }
    } else if (message.role === "toolResult") {
      pending.delete(message.toolCallId);
    }
  }
  if (pending.size > 0) throw new Error("Resolve pending tool calls before native compaction.");
}

/**
 * Current transcript tools the last turn request did not send. Pi hides them
 * from requests in codemode `only` mode. Pi hides only current tools, and a
 * tool a turn removed is no longer current. A request sends the tools in its
 * `tools` and the ones its messages define inline. Names compare
 * case-insensitively, because OAuth requests send Claude Code's capitalized
 * names for Pi's tools.
 */
export function hiddenTools(
  messages: readonly Message[],
  savedTemplate: JsonObject,
): ReadonlySet<string> {
  const tools = savedTemplate["tools"];
  const inline = savedTemplate["inlineTools"];
  const sent = new Set([
    ...(Array.isArray(tools) ? objects(tools) : []).flatMap((tool) =>
      typeof tool["name"] === "string" ? [tool["name"].toLowerCase()] : [],
    ),
    ...(Array.isArray(inline) ? inline : []).flatMap((name) =>
      typeof name === "string" ? [name.toLowerCase()] : [],
    ),
  ]);
  return new Set(
    getCurrentTools([...messages])
      .map((tool) => tool.name)
      .filter((name) => !sent.has(name.toLowerCase())),
  );
}

/** Remove hidden tools from every tool declaration change, as Pi projects requests. */
export function withoutHiddenTools(
  messages: readonly Message[],
  hidden: ReadonlySet<string>,
): Message[] {
  if (hidden.size === 0) return [...messages];
  return messages.map((message) => {
    if (message.role !== "system" || (!message.toolsAdded && !message.toolsRemoved)) {
      return message;
    }
    const { toolsAdded, toolsRemoved, ...rest } = message;
    const added = toolsAdded?.filter((tool) => !hidden.has(tool.name)) ?? [];
    const removed = toolsRemoved?.filter((tool) => !hidden.has(tool.name)) ?? [];
    return {
      ...rest,
      ...(added.length > 0 ? { toolsAdded: added } : {}),
      ...(removed.length > 0 ? { toolsRemoved: removed } : {}),
    };
  });
}

export function compactedTranscript(
  whole: readonly Message[],
  kept: readonly Message[],
): TranscriptContext {
  const snapshot = getCurrentSystemMessage(whole);
  return normalizeContext({ messages: snapshot ? [snapshot, ...kept] : [...kept] });
}
export function activeCheckpoint(entries: readonly SessionEntry[]) {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== "compaction") continue;
    const saved = checkpoint(entry.details);
    if (!saved || saved.tools) return saved;
    const names = referencedTools(saved.block);
    if (names.length === 0) return saved;
    // Checkpoints written before 0.0.15 do not record the definitions of the tools their block
    // names. The summary request declared the tools of the last turn before compaction.
    const summarized = activeTemplate(entries.slice(0, index), saved.model);
    return summarized ? { ...saved, tools: toolDefinitions(summarized, names) } : saved;
  }
  return undefined;
}

export function activeTemplate(
  entries: readonly SessionEntry[],
  model: string,
): JsonObject | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== TEMPLATE_TYPE) continue;
    const data = object(entry.data);
    if (data["model"] === model) return data;
  }
  return undefined;
}

class SummaryCaptured extends Error {
  constructor() {
    super("Native summary captured.");
  }
}

export function registerCompatibility(pi: ExtensionAPI, fetcher: typeof fetch = fetch): void {
  let config: Config | undefined;
  // Pi can serialize a turn twice: after a strict-tool-limit rejection it retries once with
  // preferred strict tools non-strict. Only the template of the request Anthropic accepted is
  // recorded, when `after_provider_response` reports success.
  let record: ((ctx: ExtensionContext) => void) | undefined;

  const configuration = (ctx: Parameters<typeof loadSessionConfig>[0]): Config => {
    config ??= loadSessionConfig(ctx);
    return config;
  };
  const reset = () => {
    config = undefined;
    record = undefined;
  };
  pi.on("session_start", reset);
  pi.on("session_shutdown", reset);

  // Once a signed checkpoint exists, it replaces Pi's readable summary on the wire. The event
  // returns messages verbatim, so a changed list keeps every system message where it is.
  pi.on("context_with_system", (event, ctx) => {
    if (!eligibleModel(ctx.model)) return;
    const branch = ctx.sessionManager.getBranch();
    const saved = activeCheckpoint(branch);
    const messages = saved
      ? event.messages.filter((message) => message.role !== "compactionSummary")
      : event.messages;
    // Agent turns lead with the prompt, as Pi sends them without an earlier shell command. A
    // branch starts moving its prompt only while native compaction is on, and keeps its order
    // once it has recorded the move.
    const recorded = promptFirstRecorded(branch);
    const ordered =
      recorded || configuration(ctx).enabled
        ? promptFirst(messages, recorded, (message) =>
            convertToLlm([message]).every((converted) => converted.role === "user"),
          )
        : undefined;
    if (ordered && !recorded) pi.appendEntry(PROMPT_FIRST_TYPE, { version: 1 });
    return ordered ? { messages: ordered } : saved ? { messages } : undefined;
  });

  pi.on("before_provider_request", (event, ctx) => {
    record = undefined;
    const model = ctx.model;
    if (!eligibleModel(model)) return undefined;
    const payload = event.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
    const request = object(payload);
    // Ignore requests for other models, such as nested calls by other extensions.
    if (request["model"] !== model.id) return undefined;
    if (configuration(ctx).enabled) {
      const next = template(request);
      record = (current) => {
        const saved = activeTemplate(current.sessionManager.getBranch(), model.id);
        if (JSON.stringify(saved) !== JSON.stringify(next)) pi.appendEntry(TEMPLATE_TYPE, next);
      };
    }
    const saved = activeCheckpoint(ctx.sessionManager.getBranch());
    return saved ? replay(request, saved) : undefined;
  });

  pi.on("after_provider_response", (event, ctx) => {
    const accepted = record;
    record = undefined;
    if (event.status >= 200 && event.status < 300) accepted?.(ctx);
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (!eligibleModel(ctx.model)) return;
    try {
      if (!configuration(ctx).enabled) return;
      const model = ctx.model;
      const leaf = ctx.sessionManager.getLeafId();
      const session = ctx.sessionManager.getSessionId();
      const branch = ctx.sessionManager.getBranch();
      const saved = activeCheckpoint(branch);
      const savedTemplate = activeTemplate(branch, model.id);
      if (!savedTemplate) {
        throw new Error(
          "Run an Anthropic turn before compacting so final system instructions and tools can be captured.",
        );
      }
      const signal = AbortSignal.any([
        event.signal,
        AbortSignal.timeout(configuration(ctx).timeoutSeconds * 1000),
      ]);
      signal.throwIfAborted();
      // Emulated keep-tail: summarize only what Pi's own split (compaction.keepRecentTokens)
      // discards. Pi keeps entries from firstKeptEntryId verbatim after the summary.
      // Signed thinking in kept messages no longer matches its original prefix, so
      // Anthropic drops it by default; no prefix_mismatch_behavior is requested.
      const { preparation } = event;
      const transcript = convertToLlm(
        [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages].filter(
          (message) => message.role !== "compactionSummary",
        ),
      );
      // Pi leaves tools it hides (codemode `only` mode) out of every request
      // after extensions see the transcript. The saved template lists the tools
      // the last turn sent, so the others are removed here as Pi removes them.
      const hidden = hiddenTools(transcript, savedTemplate);
      const messages = withoutHiddenTools(transcript, hidden);
      if (!messages.some((message) => message.role === "user" || message.role === "assistant")) {
        throw new Error("Nothing to summarize before the kept messages.");
      }
      const maxTokens = Math.min(configuration(ctx).maxSummaryTokens, model.maxTokens);
      const level = pi.getThinkingLevel();

      const instructions = summaryInstructions(
        configuration(ctx).summaryInstructions,
        event.customInstructions,
      );
      // Serialize the summary request through the registered provider and send what comes out.
      const attempt: {
        response?: JsonObject;
        /** The summary request before the registered provider's transform. */
        payload?: JsonObject;
        unsupported: boolean;
        // The SDK reports any transport exception as "Connection error.", so keep the cause.
        failure?: unknown;
      } = { unsupported: false };
      const options: SimpleStreamOptions = {
        signal,
        sessionId: session,
        maxRetries: 0,
        maxTokens,
        ...(level === "off" ? {} : { reasoning: level }),
        // Runs before the registered provider's own payload transform (for example
        // pi-black's Claude Code system blocks), so they still apply afterward.
        onPayload: (payload) => {
          const result = object(payload);
          for (const key of ["system", "tools", "thinking", "output_config"] as const) {
            if (savedTemplate[key] === undefined) delete result[key];
            else result[key] = savedTemplate[key];
          }
          const replayed = replay(result, saved);
          if (replayed["model"] !== model.id) {
            throw new Error("A provider transform changed the summary model.");
          }
          attempt.payload = replayed;
          return summaryPayload(replayed, maxTokens, instructions);
        },
        // The registered provider's fetch wrapper (for example pi-black's cch patch)
        // calls this transport last, with the final headers and body.
        fetch: async (input, init) => {
          try {
            const request = new Request(input, init);
            if (!(await supportsCompaction(request, model.id, signal, fetcher))) {
              attempt.unsupported = true;
            } else {
              attempt.response = await sendSummaryRequest(request, signal, fetcher, {
                onRetry: ({ attempt: retry, maxRetries, delayMs, reason }) => {
                  ctx.ui.notify(
                    `Native compaction failed (${reason}). Retrying in ${Math.ceil(delayMs / 1000)} s, attempt ${retry} of ${maxRetries}.`,
                    "warning",
                  );
                },
              });
            }
          } catch (error) {
            attempt.failure = error;
          }
          throw new SummaryCaptured();
        },
      };
      const result = await ctx.modelRegistry
        .streamSimple(model, normalizeContext({ messages }), options)
        .result();
      signal.throwIfAborted();
      const { response, unsupported, failure } = attempt;
      if (unsupported) {
        ctx.ui.notify(
          "This model does not support native compaction. Pi compaction remains available.",
          "warning",
        );
        return;
      }
      if (failure)
        throw failure instanceof Error ? failure : new Error("Native compaction transport failed.");
      if (!response) {
        throw new Error(result.errorMessage ?? "Could not send the Anthropic compaction request.");
      }
      const summary = parseSummary(response, model);
      // Replay must declare every tool the block's net tool changes name.
      const referenced = referencedTools(summary.block);
      const referencedDefinitions = toolDefinitions(attempt.payload ?? {}, referenced);
      if (referencedDefinitions.length !== referenced.length) {
        throw new Error(
          "The summary refers to a tool the summary request did not declare. History was preserved.",
        );
      }
      if (
        ctx.sessionManager.getSessionId() !== session ||
        ctx.sessionManager.getLeafId() !== leaf ||
        ctx.model?.id !== model.id
      ) {
        throw new Error("The session changed during compaction. The summary was not applied.");
      }
      const boundary = preparation.firstKeptEntryId;
      return {
        compaction: {
          summary: summary.summary,
          firstKeptEntryId: boundary,
          tokensBefore: event.preparation.tokensBefore,
          usage: summary.usage,
          details: {
            type: CHECKPOINT_TYPE,
            version: 1,
            model: model.id,
            block: summary.block,
            ...(referencedDefinitions.length > 0 ? { tools: referencedDefinitions } : {}),
          },
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Native compaction failed.";
      // No automatic switch to a text-summary algorithm after a native failure.
      ctx.ui.notify(message, "error");
      pi.events.emit(COMPACTION_CANCELLED_CHANNEL, {
        source: "pi-anthropic-compat",
        reason: message,
      });
      return { cancel: true };
    }
  });

  registerSettings(pi, {
    get: configuration,
    set: (next) => {
      config = next;
    },
  });
}
