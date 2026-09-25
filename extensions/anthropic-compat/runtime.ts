import { normalizeContext, type Message, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
  convertToLlm,
  buildSessionContext,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { sendSummaryRequest, supportsCompaction } from "./client.ts";
import { loadConfig, type Config } from "./config.ts";
import { object, type JsonObject } from "./json.ts";
import {
  CHECKPOINT_TYPE,
  TEMPLATE_TYPE,
  checkpoint,
  eligibleModel,
  parseSummary,
  replay,
  summaryPayload,
  template,
} from "./protocol.ts";
import { registerSettings } from "./settings.ts";

// This fork never replaces the `anthropic` provider. Another extension (for example
// pi-black) may own it. Replay happens in `before_provider_request`, which Pi runs
// inside the provider's `onPayload` chain before provider-specific transforms and
// before the request body is serialized. Summary requests go through
// `ctx.modelRegistry.streamSimple`, so they pass through the registered provider too.

export function requireCompletedTools(messages: readonly Message[]): void {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const item of message.content) {
        if (item.type === "toolCall") pending.add(item.id);
      }
    } else if (message.role === "toolResult") {
      pending.delete(message.toolCallId);
    }
  }
  if (pending.size > 0) throw new Error("Resolve pending tool calls before native compaction.");
}

export function activeCheckpoint(entries: readonly SessionEntry[]) {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type === "compaction") return checkpoint(entry.details);
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

  const configuration = (ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): Config => {
    config ??= loadConfig(ctx.cwd, ctx.isProjectTrusted()).config;
    return config;
  };
  const reset = () => {
    config = undefined;
  };
  pi.on("session_start", reset);
  pi.on("session_shutdown", reset);

  // Once a signed checkpoint exists, it replaces Pi's readable summary on the wire.
  pi.on("context_with_system", (event, ctx) => {
    if (!eligibleModel(ctx.model) || !activeCheckpoint(ctx.sessionManager.getBranch())) return;
    return { messages: event.messages.filter((message) => message.role !== "compactionSummary") };
  });

  pi.on("before_provider_request", (event, ctx) => {
    const model = ctx.model;
    if (!eligibleModel(model)) return undefined;
    const payload = event.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
    const request = object(payload);
    // Ignore requests for other models, such as nested calls by other extensions.
    if (request["model"] !== model.id) return undefined;
    const branch = ctx.sessionManager.getBranch();
    if (configuration(ctx).enabled) {
      const next = template(request);
      if (JSON.stringify(activeTemplate(branch, model.id)) !== JSON.stringify(next)) {
        pi.appendEntry(TEMPLATE_TYPE, next);
      }
    }
    const saved = activeCheckpoint(branch);
    return saved ? replay(request, saved) : undefined;
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
      requireCompletedTools(convertToLlm(buildSessionContext(branch, leaf).messages));
      // Emulated keep-tail: summarize only what Pi's own split (compaction.keepRecentTokens)
      // discards. Pi keeps entries from firstKeptEntryId verbatim after the summary.
      // Signed thinking in kept messages no longer matches its original prefix, so
      // Anthropic drops it by default; no prefix_mismatch_behavior is requested.
      const { preparation } = event;
      const messages = convertToLlm(
        [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages].filter(
          (message) => message.role !== "compactionSummary",
        ),
      );
      if (!messages.some((message) => message.role === "user" || message.role === "assistant")) {
        throw new Error("Nothing to summarize before the kept messages.");
      }
      requireCompletedTools(messages);
      const maxTokens = Math.min(configuration(ctx).maxSummaryTokens, model.maxTokens);
      const level = pi.getThinkingLevel();

      let response: JsonObject | undefined;
      let unsupported = false;
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
          return summaryPayload(replayed, maxTokens, event.customInstructions);
        },
        // The registered provider's fetch wrapper (for example pi-black's cch patch)
        // calls this transport last, with the final headers and body.
        fetch: async (input, init) => {
          const request = new Request(input, init);
          if (!(await supportsCompaction(request, model.id, signal, fetcher))) {
            unsupported = true;
          } else {
            response = await sendSummaryRequest(request, signal, fetcher);
          }
          throw new SummaryCaptured();
        },
      };
      const result = await ctx.modelRegistry
        .streamSimple(model, normalizeContext({ messages }), options)
        .result();
      signal.throwIfAborted();
      if (unsupported) {
        ctx.ui.notify(
          "This model does not support native compaction. Pi compaction remains available.",
          "warning",
        );
        return;
      }
      if (!response) {
        throw new Error(result.errorMessage ?? "Could not send the Anthropic compaction request.");
      }
      const summary = parseSummary(response, model);
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
          details: { type: CHECKPOINT_TYPE, version: 1, model: model.id, block: summary.block },
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Native compaction failed.";
      // No automatic switch to a text-summary algorithm after a native failure.
      ctx.ui.notify(message, "error");
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
