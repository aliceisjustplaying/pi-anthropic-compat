import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  createCodemodeExtension,
  defineTool,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, type Message } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  registerCompatibility,
  activeCheckpoint,
  activeTemplate,
  hiddenTools,
  withoutHiddenTools,
} from "../extensions/anthropic-compat/runtime.ts";
import { object, objects, type JsonObject } from "../extensions/anthropic-compat/json.ts";
import {
  COMPACTION_CANCELLED_CHANNEL,
  TEMPLATE_TYPE,
} from "../extensions/anthropic-compat/protocol.ts";
import { PROMPT_FIRST_TYPE } from "../extensions/anthropic-compat/prompt-order.ts";
import { block, model, summaryResponse, textResponse } from "./support/fixtures.ts";
import { SESSION_SETTINGS_TYPE } from "../extensions/anthropic-compat/settings.ts";
import { DEFAULT_CONFIG } from "../extensions/anthropic-compat/config.ts";
import { sessionSettingsEntry } from "../extensions/settings-session.ts";

const BILLING = "x-anthropic-billing-header: cc_version=test; cch=00000;";

/** Mirrors pi-black: wraps the built-in provider, prepends a billing block in
 * `onPayload` after earlier transforms, and signs the serialized body in `fetch`. */
function fakeBlack(pi: ExtensionAPI): void {
  const anthropic = builtinProviders().find((provider) => provider.id === "anthropic");
  assert.ok(anthropic);
  const merge = <T extends SimpleStreamOptions | undefined>(options: T): T => {
    if (!options) return options;
    const transport = options.fetch ?? globalThis.fetch;
    return {
      ...options,
      onPayload: async (payload: unknown, selected: Model<Api>) => {
        const prior = object((await options.onPayload?.(payload, selected)) ?? payload);
        const system = Array.isArray(prior["system"]) ? prior["system"] : [];
        return { ...prior, system: [{ type: "text", text: BILLING }, ...system] };
      },
      fetch: async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const request = new Request(input, init);
        const body = (await request.text()).replace("cch=00000", "cch=abcde");
        const signed = new Headers(request.headers);
        signed.set("x-fake-black", "1");
        signed.delete("content-length");
        return transport(request.url, { method: request.method, headers: signed, body });
      },
    };
  };
  pi.registerProvider({
    ...anthropic,
    streamSimple: (m, c, o) => anthropic.streamSimple(m, c, merge(o)),
  });
}

const execute = async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} });
const reportTool = defineTool({
  name: "report",
  label: "Report",
  description: "Report a value.",
  parameters: Type.Object({ value: Type.String() }),
  execute,
});
// Anthropic rejects strict tool sets above its limits. Pi then retries with this tool non-strict.
const strictTool = defineTool({
  name: "strict_report",
  label: "Strict report",
  description: "Report a value with strict arguments.",
  parameters: Type.Object({ value: Type.String() }, { additionalProperties: false }),
  constrainedSampling: { type: "json_schema", strict: "prefer" },
  execute,
});
const strictToolLimit = () =>
  Response.json(
    {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "Too many strict tools (21). The maximum number of strict tools supported is 20",
      },
    },
    { status: 400 },
  );
/** Messages without cache breakpoints, which Pi moves to the newest block on every request. */
const bare = (messages: unknown) =>
  JSON.stringify(messages, (key, value: unknown) => (key === "cache_control" ? undefined : value));
const hasStrictTool = (body: JsonObject) =>
  body["tools"] !== undefined && objects(body["tools"]).some((tool) => tool["strict"] === true);

const handoffTool = defineTool({
  name: "handoff",
  label: "Handoff",
  description: "Hand off the session.",
  parameters: Type.Object({ goal: Type.String() }),
  exposure: "model-only",
  execute,
});

async function setup(
  t: TestContext,
  options: {
    automatic?: boolean;
    fail?: boolean;
    enabled?: boolean;
    persistent?: boolean;
    /** Register a pi-black-style native wrapper around the built-in Anthropic provider. */
    black?: boolean;
    /** Pi's compaction.keepRecentTokens. */
    keep?: number;
    /** Write this `summaryInstructions` value to the configuration file. */
    summaryInstructions?: string;
    managed?: boolean;
    modelId?: "claude-opus-5-5" | "claude-haiku-5-5";
    /** Replace the serialized system prompt at the payload boundary. Default: true. */
    patchSystem?: boolean;
    /** Activate Pi codemode in this mode next to a direct and a model-only tool. */
    codemode?: "on" | "only";
    /**
     * Offer a strict-preferred tool and reject requests that send it strict: every request, or
     * only summary requests.
     */
    strictLimit?: boolean | "compaction";
    /** Offer these tools instead of none. */
    customTools?: ToolDefinition[];
    /** The signed block the summary returns. Default: the fixture block. */
    summaryBlock?: JsonObject;
    /** Answer this many summary requests with Anthropic's transient compaction failure. */
    unavailableSummaries?: number;
    /** Collect extension notifications. */
    notices?: string[];
    /** Collect the payloads published on the compaction-cancelled channel. */
    cancellations?: unknown[];
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "anthropic-integration-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  await writeFile(
    join(agentDir, "pi-anthropic-compat.json"),
    JSON.stringify({
      enabled: options.enabled ?? true,
      summaryInstructions: options.summaryInstructions,
    }),
  );
  const original = process.env["PI_CODING_AGENT_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  t.after(() => {
    if (original === undefined) delete process.env["PI_CODING_AGENT_DIR"];
    else process.env["PI_CODING_AGENT_DIR"] = original;
  });
  const requests: JsonObject[] = [];
  const headers: Headers[] = [];
  let unavailable = 0;
  let ordinary = 0;
  let contextWindow = model.contextWindow;
  let onSummary: (() => void) | undefined;
  let system = "Patched synthetic system.";
  let section: string | undefined;
  const selected = options.modelId
    ? getModel("anthropic", options.modelId)
    : options.managed
      ? { ...model, id: "claude-fable-5-1" }
      : model;
  assert.ok(selected);
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(new URL(request.url).origin, "https://api.anthropic.com");
    headers.push(request.headers);
    if (request.method === "GET") {
      return Response.json({ capabilities: { compaction: { summarize: { supported: true } } } });
    }
    const body = object(await request.json());
    requests.push(body);
    if (
      hasStrictTool(body) &&
      (options.strictLimit === true || (options.strictLimit === "compaction" && body["compaction"]))
    ) {
      return strictToolLimit();
    }
    if (body["compaction"]) {
      onSummary?.();
      if ((options.unavailableSummaries ?? 0) > unavailable) {
        unavailable++;
        return Response.json(
          {
            type: "error",
            error: {
              type: "overloaded_error",
              message: "Overloaded",
              details: { error_code: "compaction_unavailable" },
            },
          },
          // A zero server delay keeps the test fast.
          { status: 529, headers: { "retry-after": "0" } },
        );
      }
      if (options.fail)
        return Response.json({
          ...summaryResponse(selected.id),
          content: [],
          stop_reason: "max_tokens",
        });
      return Response.json({
        ...summaryResponse(selected.id),
        content: [options.summaryBlock ?? block],
      });
    }
    ordinary++;
    return textResponse(
      options.automatic && ordinary === 1 ? contextWindow - 1024 : 100,
      selected.id,
      options.managed,
    );
  };
  t.mock.method(globalThis, "fetch", fetcher);
  const manager = options.persistent
    ? SessionManager.create(root, join(root, "sessions"))
    : SessionManager.inMemory(root);
  const create = async (sessionManager = manager) => {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStorePath: join(agentDir, "models-store.json"),
      allowModelNetwork: false,
    });
    await runtime.setRuntimeApiKey("anthropic", "test-only");
    const settings = SettingsManager.inMemory({
      compaction: {
        enabled: options.automatic ?? false,
        keepRecentTokens: options.keep ?? 1,
        reserveTokens: 16384,
      },
      retry: { enabled: false, provider: { maxRetries: 0 } },
      ...(options.codemode ? { codemode: { mode: options.codemode } } : {}),
    });
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager: settings,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => "Synthetic system before patch.",
      extensionFactories: [
        ...(options.black ? [fakeBlack] : []),
        // Another extension, such as pi-compact-assistant, reads cancellation reasons.
        (pi) =>
          pi.events.on(COMPACTION_CANCELLED_CHANNEL, (data) => {
            options.cancellations?.push(data);
          }),
        // A system-prompt transformer loaded before this extension is captured in the
        // template. Transformers loaded after it are not; load this extension last.
        (pi) =>
          pi.on("before_provider_request", (event) =>
            options.patchSystem === false
              ? undefined
              : { ...object(event.payload), system: [{ type: "text", text: system }] },
          ),
        (pi) => registerCompatibility(pi, fetcher),
        // Structured prompt changes persist as later transcript system messages.
        (pi) =>
          pi.on("before_agent_start", (event) => {
            if (section !== undefined) event.systemPromptOptions.sections["fixture"] = section;
          }),
        ...(options.codemode ? [createCodemodeExtension()] : []),
      ],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await createAgentSession({
      cwd: root,
      agentDir,
      modelRuntime: runtime,
      model: selected,
      thinkingLevel: options.managed ? "low" : "off",
      sessionManager,
      settingsManager: settings,
      resourceLoader: loader,
      ...(options.codemode
        ? { noTools: "builtin" as const, customTools: [reportTool, handoffTool] }
        : options.strictLimit
          ? { noTools: "builtin" as const, customTools: [strictTool] }
          : options.customTools
            ? { noTools: "builtin" as const, customTools: options.customTools }
            : { noTools: "all" as const }),
    });
    const notices = options.notices;
    await session.bindExtensions(
      notices
        ? {
            uiContext: {
              ...session.extensionRunner.getUIContext(),
              notify: (message, level) => {
                notices.push(`${level}: ${message}`);
              },
            },
          }
        : {},
    );
    if (options.codemode) session.setActiveToolsByName(["report", "handoff", "codemode"]);
    if (options.strictLimit) session.setActiveToolsByName(["strict_report"]);
    contextWindow = session.model?.contextWindow ?? model.contextWindow;
    t.after(() => session.dispose());
    return session;
  };
  const session = await create();
  return {
    session,
    configFile: join(agentDir, "pi-anthropic-compat.json"),
    manager,
    requests,
    headers,
    create,
    setSystem: (value: string) => {
      system = value;
    },
    setSection: (value: string) => {
      section = value;
    },
    interrupt: (callback: () => void) => {
      onSummary = callback;
    },
  };
}

test("native compaction restores session configuration before requests after reload and resume", async (t) => {
  const { session, manager, create, requests } = await setup(t, {
    enabled: false,
    persistent: true,
  });
  await session.prompt("Remember the synthetic project Lantern.");
  manager.appendCustomEntry(
    SESSION_SETTINGS_TYPE,
    sessionSettingsEntry(
      manager.getSessionId(),
      { ...DEFAULT_CONFIG, enabled: true },
      { changes: {} },
      {},
    ),
  );
  await session.reload();
  // This fork records request templates only while native compaction is on.
  await session.prompt("Record a template now that native compaction is on.");
  await session.compact();
  assert.ok(requests.at(-1)?.["compaction"]);
  const file = manager.getSessionFile();
  assert.ok(file);
  const resumed = await create(SessionManager.open(file));
  await resumed.prompt("Continue after resume.");
  await resumed.compact();
  assert.ok(requests.at(-1)?.["compaction"]);
});

test("configured summary instructions replace the default guidance and precede /compact guidance", async (t) => {
  const { session, requests } = await setup(t, {
    summaryInstructions: "Keep each task's wording and priority.",
  });
  await session.prompt("Remember the synthetic project Lantern.");
  await session.compact("Name the project.");
  const summary = requests.findLast((request) => request["compaction"]);
  assert.deepEqual(summary?.["compaction"], {
    type: "summarize",
    instructions: [
      "Keep each task's wording and priority.",
      "Do not call tools. Respond with text only.",
      "Name the project.",
    ].join("\n\n"),
  });
});

test("tree navigation retains active session configuration instead of reloading files", async (t) => {
  const { session, manager, requests, configFile } = await setup(t);
  await session.prompt("Remember the synthetic project Lantern.");
  const user = manager
    .getBranch()
    .find((entry) => entry.type === "message" && entry.message.role === "user");
  assert.ok(user);
  await writeFile(configFile, JSON.stringify({ enabled: false }));
  await session.navigateTree(user.id);
  await session.prompt("Continue on this branch.");
  const result = await session.compact();
  assert.equal(result.summary, block["content"]);
  assert.ok(requests.some((request) => request["compaction"]));
});

test("real Pi session compacts, replays exactly one native block, and retains original history", async (t) => {
  const { session, manager, requests } = await setup(t);
  await session.prompt("Remember the synthetic project Lantern.");
  assert.ok(activeTemplate(manager.getBranch(), model.id));
  const oldMessages = manager.getEntries().filter((entry) => entry.type === "message").length;
  const result = await session.compact("Preserve the project name.");
  assert.equal(result.summary, block["content"]);
  assert.equal(result.usage?.input, 194);
  // Pi leads with its prompt snapshot; Pi's split keeps the last response verbatim.
  assert.deepEqual(
    session.messages.map((message) => message.role),
    ["system", "compactionSummary", "assistant"],
  );
  assert.equal(
    manager.getEntries().filter((entry) => entry.type === "message").length,
    oldMessages,
  );
  const summaryRequest = requests.find((request) => request["compaction"]);
  assert.ok(summaryRequest);
  assert.deepEqual(summaryRequest["system"], [{ type: "text", text: "Patched synthetic system." }]);
  assert.match(JSON.stringify(summaryRequest["messages"]), /Lantern/);
  await session.prompt("Continue.");
  const latest = requests.at(-1);
  assert.ok(latest);
  const messages = objects(latest["messages"]);
  assert.deepEqual(messages[0], { role: "assistant", content: [block] });
  assert.equal(JSON.stringify(messages).includes("Remember the synthetic project"), false);
  assert.equal(
    JSON.stringify(messages).includes("The conversation history before this point"),
    false,
  );
  await session.compact();
  const repeated = requests.at(-1);
  assert.ok(repeated);
  assert.deepEqual(objects(repeated["messages"])[0], { role: "assistant", content: [block] });
});

for (const modelId of ["claude-opus-5-5", "claude-haiku-5-5"] as const) {
  test(`${modelId} compacts and replays`, async (t) => {
    const { session, manager, requests } = await setup(t, {
      modelId,
      managed: true,
    });
    await session.prompt("Remember the synthetic project Lantern.");
    await session.compact();
    assert.equal(activeCheckpoint(manager.getBranch())?.model, modelId);
    await session.prompt("Continue.");
    const latest = requests.at(-1);
    assert.ok(latest);
    assert.equal(latest["model"], modelId);
    assert.deepEqual(objects(latest["messages"])[0], { role: "assistant", content: [block] });
  });
}

test("native replay and manual compaction survive extension reload and branch navigation", async (t) => {
  const { session, manager, requests, create } = await setup(t, { persistent: true });
  await session.prompt("Original branch facts.");
  const before = manager.getLeafId();
  assert.ok(before);
  await session.compact();
  await session.prompt("A new turn before restart.");
  const file = manager.getSessionFile();
  assert.ok(file);
  session.dispose();
  const restored = SessionManager.open(file);
  const resumed = await create(restored);
  await resumed.compact();
  await resumed.prompt("Resumed.");
  const replayed = requests.at(-1);
  assert.ok(replayed);
  assert.deepEqual(objects(replayed["messages"])[0], { role: "assistant", content: [block] });
  await resumed.compact();
  await resumed.navigateTree(before, { summarize: false });
  assert.equal(activeCheckpoint(restored.getBranch()), undefined);
  await resumed.prompt("Different branch.");
  assert.equal(JSON.stringify(requests.at(-1)).includes("test-signature"), false);
});

test("aborted native compaction preserves the original session", async (t) => {
  const { session, manager, interrupt } = await setup(t);
  await session.prompt("Keep facts after abort.");
  const leaf = manager.getLeafId();
  interrupt(() => session.abortCompaction());
  await assert.rejects(session.compact(), /cancelled/i);
  assert.equal(manager.getLeafId(), leaf);
  assert.equal(activeCheckpoint(manager.getBranch()), undefined);
});

test("concurrent session changes invalidate an in-flight summary without overwriting them", async (t) => {
  const { session, manager, interrupt } = await setup(t);
  await session.prompt("Keep original branch.");
  interrupt(() => {
    manager.appendCustomEntry("concurrent-fixture", { preserved: true });
  });
  await assert.rejects(session.compact(), /cancelled/i);
  assert.equal(manager.getLeafEntry()?.type, "custom");
  assert.equal(activeCheckpoint(manager.getBranch()), undefined);
});

test("native failure cancels compaction without losing history or falling back", async (t) => {
  const { session, manager, requests } = await setup(t, { fail: true });
  await session.prompt("Keep these facts.");
  const leaf = manager.getLeafId();
  await assert.rejects(session.compact(), /cancelled/i);
  assert.equal(manager.getLeafId(), leaf);
  assert.equal(activeCheckpoint(manager.getBranch()), undefined);
  assert.equal(requests.length, 2);
});

test("a cancelled compaction publishes its reason for other extensions", async (t) => {
  const cancellations: unknown[] = [];
  const { session } = await setup(t, { fail: true, cancellations });
  await session.prompt("Keep these facts.");
  // Pi reports only that the compaction was cancelled.
  await assert.rejects(session.compact(), { message: "Compaction cancelled" });
  assert.deepEqual(cancellations, [
    {
      source: "pi-anthropic-compat",
      reason: "Native compaction produced no summary (max_tokens). History was preserved.",
    },
  ]);
});

test("a successful compaction publishes no cancellation", async (t) => {
  const cancellations: unknown[] = [];
  const { session } = await setup(t, { cancellations });
  await session.prompt("Keep these facts.");
  await session.compact();
  assert.deepEqual(cancellations, []);
});

test("a transient compaction failure is retried with a warning", async (t) => {
  const notices: string[] = [];
  const { session, manager, requests } = await setup(t, { unavailableSummaries: 2, notices });
  await session.prompt("Remember the synthetic project Lantern.");
  const result = await session.compact();
  assert.equal(result.summary, block["content"]);
  assert.ok(activeCheckpoint(manager.getBranch()));
  const summaries = requests.filter((request) => request["compaction"]);
  assert.equal(summaries.length, 3);
  assert.equal(new Set(summaries.map((request) => JSON.stringify(request))).size, 1);
  assert.deepEqual(notices, [
    "warning: Native compaction failed (HTTP 529 overloaded_error, compaction_unavailable). Retrying in 0 s, attempt 1 of 3.",
    "warning: Native compaction failed (HTTP 529 overloaded_error, compaction_unavailable). Retrying in 0 s, attempt 2 of 3.",
  ]);
});

const removedReport: JsonObject = {
  ...block,
  tool_changes: [{ type: "tool_removal", tool: { type: "tool_reference", name: "report" } }],
};

/** The `report` declarations in a request's top-level tools. */
function reportDeclarations(request: JsonObject | undefined): JsonObject[] {
  return objects(request?.["tools"]).filter((tool) => tool["name"] === "report");
}

test("replay restates a tool the signed block removes after Pi withdrew it", async (t) => {
  const { session, manager, requests } = await setup(t, {
    codemode: "on",
    modelId: "claude-opus-5-5",
    managed: true,
    summaryBlock: removedReport,
  });
  await session.prompt("Remember the synthetic project Lantern.");
  session.setActiveToolsByName(["handoff", "codemode"]);
  await session.prompt("Remember the synthetic city Harbor.");
  await session.compact();
  const saved = activeCheckpoint(manager.getBranch());
  assert.deepEqual(
    saved?.tools?.map((tool) => tool["name"]),
    ["report"],
  );
  await session.prompt("Continue.");
  const latest = requests.at(-1);
  assert.deepEqual(objects(latest?.["messages"])[0], {
    role: "assistant",
    content: [removedReport],
  });
  const declarations = reportDeclarations(latest);
  assert.equal(declarations.length, 1);
  assert.equal(declarations[0]?.["cache_control"], undefined);
  const last = session.messages.at(-1);
  assert.ok(last?.role === "assistant" && last.stopReason === "stop");
});

test("replay restates removed tools for checkpoints that recorded no definitions", async (t) => {
  const { session, manager, requests, create } = await setup(t, {
    codemode: "on",
    modelId: "claude-opus-5-5",
    managed: true,
    persistent: true,
    summaryBlock: removedReport,
  });
  await session.prompt("Remember the synthetic project Lantern.");
  session.setActiveToolsByName(["handoff", "codemode"]);
  await session.prompt("Remember the synthetic city Harbor.");
  await session.compact();
  const file = manager.getSessionFile();
  assert.ok(file);
  session.dispose();
  // Version 0.0.14 wrote the same checkpoint without tool definitions.
  const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
  await writeFile(
    file,
    `${lines
      .map((line) => {
        const entry = object(JSON.parse(line));
        if (entry["type"] !== "compaction") return line;
        const { tools: _tools, ...details } = object(entry["details"]);
        return JSON.stringify({ ...entry, details });
      })
      .join("\n")}\n`,
  );
  const restored = SessionManager.open(file);
  const compaction = restored.getBranch().find((entry) => entry.type === "compaction");
  assert.equal(compaction?.type === "compaction" && "tools" in object(compaction.details), false);
  const resumed = await create(restored);
  await resumed.prompt("Continue after resume.");
  const declarations = reportDeclarations(requests.at(-1));
  assert.equal(declarations.length, 1);
  assert.equal(declarations[0]?.["cache_control"], undefined);
});

test("an interrupted tool call does not block compaction", async (t) => {
  const { session, manager, requests, create } = await setup(t, {
    managed: true,
    persistent: true,
  });
  await session.prompt("Remember the synthetic project Lantern.");
  // The user interrupted a response while it streamed a tool call. Pi saves it without a result
  // and never sends it again.
  manager.appendMessage({
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: "claude-fable-5-1",
    stopReason: "aborted",
    errorMessage: "Operation aborted",
    timestamp: Date.now(),
    content: [
      { type: "toolCall", id: "interrupted-call", name: "bash", arguments: { command: "true" } },
    ],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  const file = manager.getSessionFile();
  assert.ok(file);
  session.dispose();
  const restored = SessionManager.open(file);
  const resumed = await create(restored);
  await resumed.prompt("Continue after the interruption.");
  await resumed.compact();
  const saved = activeCheckpoint(restored.getBranch());
  assert.ok(saved);
  const summary = requests.find((request) => request["compaction"]);
  assert.ok(summary);
  assert.equal(JSON.stringify(summary).includes("interrupted-call"), false);
  await resumed.prompt("Continue after compaction.");
  const latest = requests.at(-1);
  assert.ok(latest);
  assert.deepEqual(objects(latest["messages"])[0], { role: "assistant", content: [block] });
});

test("a turn Pi retries without strict tools records only the accepted request", async (t) => {
  const { session, manager, requests } = await setup(t, {
    modelId: "claude-opus-5-5",
    managed: true,
    strictLimit: true,
  });
  await session.prompt("Remember the synthetic project Lantern.");
  await session.prompt("Continue.");
  assert.deepEqual(requests.map(hasStrictTool), [true, false, true, false]);
  const custom = (type: string) =>
    manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === type);
  // Both rejected attempts are skipped: one template for the accepted request, and no more
  // while it stays the same.
  assert.equal(custom(TEMPLATE_TYPE).length, 1);
  assert.equal(
    hasStrictTool(object(activeTemplate(manager.getBranch(), "claude-opus-5-5"))),
    false,
  );
});

test("compaction after Pi's strict retry sends the tools the accepted turn sent", async (t) => {
  const { session, manager, requests } = await setup(t, {
    modelId: "claude-opus-5-5",
    managed: true,
    strictLimit: true,
  });
  await session.prompt("Remember the synthetic project Lantern.");
  const result = await session.compact();
  assert.equal(result.summary, block["content"]);
  // The template holds the non-strict tools Pi's retry sent, so the summary request is non-strict.
  const summaries = requests.filter((request) => request["compaction"]);
  assert.deepEqual(summaries.map(hasStrictTool), [false]);
  assert.equal(activeCheckpoint(manager.getBranch())?.model, "claude-opus-5-5");
  await session.prompt("Continue.");
  const latest = requests.at(-1);
  assert.ok(latest);
  assert.equal(hasStrictTool(latest), false);
  assert.deepEqual(objects(latest["messages"])[0], { role: "assistant", content: [block] });
});

test("a summary request the strict tool limit rejects cancels compaction and keeps history", async (t) => {
  const { session, manager, requests } = await setup(t, {
    modelId: "claude-opus-5-5",
    managed: true,
    strictLimit: "compaction",
  });
  await session.prompt("Remember the synthetic project Lantern.");
  const leaf = manager.getLeafId();
  await assert.rejects(session.compact(), /cancelled/i);
  assert.equal(manager.getLeafId(), leaf);
  assert.equal(activeCheckpoint(manager.getBranch()), undefined);
  assert.equal(requests.filter((request) => request["compaction"]).length, 1);
});

test("Pi automatic threshold invokes native compaction", async (t) => {
  const { session, manager, requests } = await setup(t, { automatic: true });
  const reasons: string[] = [];
  session.subscribe((event) => {
    if (event.type === "compaction_start") reasons.push(event.reason);
  });
  await session.prompt("Automatic compaction fixture.");
  assert.ok(activeCheckpoint(manager.getBranch()));
  assert.equal(requests.filter((request) => request["compaction"]).length, 1);
  assert.deepEqual(reasons, ["threshold"]);
});

test("disabled feature leaves ordinary requests unchanged", async (t) => {
  const { session, requests } = await setup(t, { enabled: false });
  await session.prompt("No compaction.");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.["compaction"], undefined);
});

test("works underneath a pi-black-style provider wrapper", async (t) => {
  const { session, manager, requests, headers } = await setup(t, { black: true });
  await session.prompt("Remember the synthetic project Lantern.");
  await session.compact();
  assert.ok(activeCheckpoint(manager.getBranch()));
  const summary = requests.find((request) => request["compaction"]);
  assert.ok(summary);
  // The summary passed through the wrapper: billing block first, body signed.
  assert.deepEqual(objects(summary["system"])[0], {
    type: "text",
    text: BILLING.replace("cch=00000", "cch=abcde"),
  });
  assert.deepEqual(objects(summary["system"])[1], {
    type: "text",
    text: "Patched synthetic system.",
  });
  assert.ok(headers.every((value) => value.get("x-fake-black") === "1"));
  assert.match(headers.at(-1)?.get("anthropic-beta") ?? "", /compact-2026-09-04/);
  await session.prompt("Continue.");
  const latest = requests.at(-1);
  assert.ok(latest);
  assert.match(JSON.stringify(objects(latest["system"])[0]), /cch=abcde/);
  assert.deepEqual(objects(latest["messages"])[0], { role: "assistant", content: [block] });
  assert.match(headers.at(-1)?.get("anthropic-beta") ?? "", /compact-2026-09-04/);
});

const noteTool = defineTool({
  name: "note",
  label: "Note",
  description: "Record a note.",
  parameters: Type.Object({ text: Type.String() }),
  execute,
});
const shellResult = {
  output: "Synthetic shell output: project Lantern.\n",
  exitCode: 0,
  cancelled: false,
  truncated: false,
};
const names = (request: JsonObject | undefined) =>
  objects(request?.["tools"]).map((tool) => tool["name"]);
const inlineTools = (request: JsonObject | undefined) =>
  objects(request?.["messages"]).flatMap((message) =>
    objects(message["content"]).flatMap((item) => {
      if (item["type"] !== "tool_addition") return [];
      const tool = object(item["tool"]);
      return tool["type"] === "tool_definition" ? [object(tool["definition"])["name"]] : [];
    }),
  );
const promptFirstEntries = (manager: SessionManager) =>
  manager
    .getBranch()
    .filter((entry) => entry.type === "custom" && entry.customType === PROMPT_FIRST_TYPE);

test("a shell command before the first prompt keeps the prompt and initial tools leading every request", async (t) => {
  const { session, manager, requests } = await setup(t, {
    modelId: "claude-opus-5-5",
    managed: true,
    patchSystem: false,
    customTools: [reportTool, noteTool],
  });
  session.setActiveToolsByName(["report"]);
  session.recordBashResult("printf Lantern", shellResult);
  await session.prompt("Remember the synthetic project Lantern.");
  const first = requests.at(-1);
  assert.ok(first);
  assert.match(JSON.stringify(first["system"]), /Synthetic system before patch/);
  assert.match(JSON.stringify(objects(first["messages"])[0]), /Synthetic shell output/);
  // Pi's placeholder shows it keeps `tools` fixed and defines later tools inline.
  assert.deepEqual(names(first), ["report", "__pi_deferred_placeholder__"]);

  session.setActiveToolsByName(["report", "note"]);
  await session.prompt("Continue.");
  const second = requests.at(-1);
  assert.ok(second);
  assert.deepEqual(second["system"], first["system"]);
  assert.deepEqual(second["tools"], first["tools"]);
  assert.deepEqual(inlineTools(second), ["note"]);
  const sent = objects(first["messages"]);
  assert.equal(
    bare(objects(second["messages"]).slice(0, sent.length)),
    bare(sent),
    "The earlier request must stay an unchanged prefix.",
  );
  assert.equal(promptFirstEntries(manager).length, 1);

  await session.compact();
  const summary = requests.at(-1);
  assert.ok(summary?.["compaction"]);
  assert.deepEqual(summary["system"], first["system"]);
  assert.deepEqual(summary["tools"], first["tools"]);
});

test("a summary request ends at a cache breakpoint so it reads the turns' cached prefix", async (t) => {
  const { session, requests } = await setup(t, {
    modelId: "claude-opus-5-5",
    managed: true,
    patchSystem: false,
  });
  await session.prompt("Remember the synthetic project Lantern.");
  await session.compact();
  const summary = requests.at(-1);
  assert.ok(summary?.["compaction"]);
  const messages = objects(summary["messages"]);
  const marked = messages.flatMap((message, index) =>
    objects(message["content"]).some((block) => block["cache_control"] !== undefined)
      ? [index]
      : [],
  );
  // Pi's split keeps the response, so the summarized prefix ends at the prompt. A trailing
  // effort marker has no content to mark.
  const last = messages.findLastIndex((message) => objects(message["content"]).length > 0);
  assert.deepEqual(marked, [last]);
  assert.equal(messages[last]?.["role"], "user");
});

test("a session answered before the prompt moved keeps its original order", async (t) => {
  const { session, requests, create } = await setup(t, {
    modelId: "claude-opus-5-5",
    managed: true,
    patchSystem: false,
    customTools: [reportTool],
  });
  await session.prompt("Remember the synthetic project Lantern.");
  // Rebuild the session as an earlier version left it: the shell output first, then a response
  // bound to that order, and no record of a move.
  const earlier = SessionManager.inMemory(session.sessionManager.getCwd());
  earlier.appendMessage({
    role: "bashExecution",
    command: "printf Lantern",
    ...shellResult,
    timestamp: 1,
  });
  for (const message of session.messages) {
    if (message.role === "branchSummary" || message.role === "compactionSummary") continue;
    earlier.appendMessage(message);
  }
  const resumed = await create(earlier);
  await resumed.prompt("Continue.");
  const request = requests.at(-1);
  assert.ok(request);
  assert.match(JSON.stringify(objects(request["messages"])[0]), /Synthetic shell output/);
  // The prompt stays a mid-conversation system message.
  assert.equal(request["system"], undefined);
  assert.match(JSON.stringify(request["messages"]), /Synthetic system before patch/);
  assert.equal(promptFirstEntries(earlier).length, 0);
});

test("emulated keep-tail summarizes older turns and replays recent ones verbatim", async (t) => {
  const { session, manager, requests } = await setup(t, { keep: 30 });
  await session.prompt("Old turn about the synthetic project Lantern.");
  await session.prompt("Old turn two.");
  await session.prompt("Recent turn about Beacon.");
  await session.compact();
  const saved = manager.getBranch().findLast((entry) => entry.type === "compaction");
  assert.ok(saved?.type === "compaction");
  assert.notEqual(saved.firstKeptEntryId, manager.getLeafId());
  const summary = requests.find((request) => request["compaction"]);
  assert.ok(summary);
  assert.match(JSON.stringify(summary["messages"]), /Old turn about/);
  assert.doesNotMatch(JSON.stringify(summary["messages"]), /Beacon/);
  await session.prompt("Continue.");
  const latest = requests.at(-1);
  assert.ok(latest);
  const messages = objects(latest["messages"]);
  assert.deepEqual(messages[0], { role: "assistant", content: [block] });
  assert.match(JSON.stringify(messages), /Recent turn about Beacon/);
  assert.doesNotMatch(JSON.stringify(messages), /Old turn about/);
});

for (const codemode of ["on", "only"] as const) {
  for (const keepRecentTokens of [0, 1]) {
    test(`native compaction declares the turn tools under codemode ${codemode} mode with keepRecentTokens=${keepRecentTokens}`, async (t) => {
      const { session, requests } = await setup(t, { codemode, keep: keepRecentTokens });
      await session.prompt("Remember the synthetic project Lantern.");
      await session.prompt("Remember the synthetic city Harbor.");
      const turn = requests.at(-1);
      assert.ok(turn);
      const names = objects(turn["tools"]).map((tool) => tool["name"]);
      assert.deepEqual(names.includes("report"), codemode === "on");
      assert.ok(names.includes("codemode") && names.includes("handoff"));
      await session.compact();
      const summary = requests.at(-1);
      assert.ok(summary?.["compaction"]);
      assert.deepEqual(summary["tools"], turn["tools"]);
      await session.prompt("Continue.");
      const continued = requests.at(-1);
      assert.ok(continued && !continued["compaction"]);
      assert.deepEqual(continued["tools"], turn["tools"]);
      assert.match(JSON.stringify(continued["messages"]), /test-opaque-content/);
    });
  }
}

for (const keepRecentTokens of [0, 1]) {
  test(`codemode only mode keeps a direct tool added mid-session out of summaries with keepRecentTokens=${keepRecentTokens}`, async (t) => {
    const { session, requests } = await setup(t, {
      codemode: "only",
      keep: keepRecentTokens,
      modelId: "claude-opus-5-5",
      managed: true,
    });
    session.setActiveToolsByName(["handoff", "codemode"]);
    await session.prompt("Remember the synthetic project Lantern.");
    // A later system message declares `report`; Pi hides it from requests.
    session.setActiveToolsByName(["report", "handoff", "codemode"]);
    await session.prompt("Remember the synthetic city Harbor.");
    const turn = requests.at(-1);
    assert.ok(turn && !turn["compaction"]);
    assert.doesNotMatch(JSON.stringify(turn), /"report"/);
    const summaries = () => requests.filter((request) => request["compaction"]);
    // This fork emulates keep-tail with Pi's own split, so a tool change does
    // not cancel compaction; the summary request must exclude the hidden tool
    // for both split sizes.
    await session.compact();
    const summary = summaries().at(-1);
    assert.ok(summary);
    assert.deepEqual(summary["tools"], turn["tools"]);
    assert.doesNotMatch(JSON.stringify(summary), /"report"/);
    await session.prompt("Continue.");
    const last = session.messages.at(-1);
    assert.ok(last?.role === "assistant" && last.stopReason === "stop", JSON.stringify(last));
  });
}

test("hidden tools are the current transcript tools the last turn did not send", () => {
  const declare = (name: string) => ({
    name,
    description: name,
    parameters: Type.Object({}),
  });
  const messages: Message[] = [
    {
      role: "system",
      content: "prompt",
      toolsAdded: [declare("read"), declare("report"), declare("codemode")],
      timestamp: 0,
    },
    { role: "system", content: "", toolsRemoved: [declare("codemode")], timestamp: 1 },
    { role: "system", content: "", toolsAdded: [declare("codemode")], timestamp: 2 },
  ];
  // OAuth requests send Claude Code's capitalized name for `read`.
  const sent = { tools: [{ name: "Read" }, { name: "codemode" }] };
  const hidden = hiddenTools(messages, sent);
  assert.deepEqual([...hidden], ["report"]);
  const projected = withoutHiddenTools(messages, hidden);
  assert.deepEqual(
    projected.flatMap((message) =>
      message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : [],
    ),
    ["read", "codemode", "codemode"],
  );
  assert.equal(withoutHiddenTools(messages, new Set()).length, messages.length);
  // A tool the request defined inline was sent.
  assert.deepEqual([...hiddenTools(messages, { ...sent, inlineTools: ["report"] })], []);
});
