import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  registerCompatibility,
  activeCheckpoint,
  activeTemplate,
} from "../extensions/anthropic-compat/runtime.ts";
import { object, objects, type JsonObject } from "../extensions/anthropic-compat/json.ts";
import { block, model, summaryResponse, textResponse } from "./fixtures.ts";

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
    managed?: boolean;
    modelId?: "claude-opus-5-5";
    /** Replace the serialized system prompt at the payload boundary. Default: true. */
    patchSystem?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "anthropic-integration-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  await writeFile(
    join(agentDir, "pi-anthropic-compat.json"),
    JSON.stringify({ enabled: options.enabled ?? true }),
  );
  const original = process.env["PI_CODING_AGENT_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  t.after(() => {
    if (original === undefined) delete process.env["PI_CODING_AGENT_DIR"];
    else process.env["PI_CODING_AGENT_DIR"] = original;
  });
  const requests: JsonObject[] = [];
  const headers: Headers[] = [];
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
    if (body["compaction"]) {
      onSummary?.();
      if (options.fail)
        return Response.json({
          ...summaryResponse(selected.id),
          content: [],
          stop_reason: "max_tokens",
        });
      return Response.json(summaryResponse(selected.id));
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
      noTools: "all",
    });
    await session.bindExtensions({});
    contextWindow = session.model?.contextWindow ?? model.contextWindow;
    t.after(() => session.dispose());
    return session;
  };
  const session = await create();
  return {
    session,
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

test("Opus 5.5 compacts and replays", async (t) => {
  const { session, manager, requests } = await setup(t, {
    modelId: "claude-opus-5-5",
    managed: true,
  });
  await session.prompt("Remember the synthetic project Lantern.");
  await session.compact();
  assert.equal(activeCheckpoint(manager.getBranch())?.model, "claude-opus-5-5");
  await session.prompt("Continue.");
  const latest = requests.at(-1);
  assert.ok(latest);
  assert.equal(latest["model"], "claude-opus-5-5");
  assert.deepEqual(objects(latest["messages"])[0], { role: "assistant", content: [block] });
});

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
