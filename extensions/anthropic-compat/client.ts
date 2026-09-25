import { object, type JsonObject } from "./json.ts";
import { COMPACTION_BETA } from "./protocol.ts";

export function betaHeaders(original: Headers): Headers {
  const headers = new Headers(original);
  const values = (headers.get("anthropic-beta") ?? "").split(",").filter(Boolean);
  headers.set("anthropic-beta", [...new Set([...values, COMPACTION_BETA])].join(","));
  headers.delete("content-length");
  return headers;
}

/**
 * Streaming SDK calls force `stream: true`, and the body cannot be changed after
 * provider wrappers sign it, so rebuild the non-streaming message from SSE events.
 */
export function collectStream(text: string): JsonObject {
  let message: JsonObject | undefined;
  const blocks: JsonObject[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const event = object(JSON.parse(line.slice(5)));
    const type = event["type"];
    if (type === "error") throw new Error("Anthropic reported a streaming error.");
    if (type === "message_start") message = { ...object(event["message"]) };
    else if (type === "content_block_start") {
      blocks[Number(event["index"])] = { ...object(event["content_block"]) };
    } else if (type === "content_block_delta") {
      const block = blocks[Number(event["index"])];
      if (!block) throw new Error("Delta for an unknown block.");
      for (const [key, value] of Object.entries(object(event["delta"]))) {
        if (key === "type" || typeof value !== "string") continue;
        const current = block[key];
        block[key] = typeof current === "string" ? current + value : value;
      }
    } else if (type === "message_delta") {
      if (!message) throw new Error("Delta before message start.");
      Object.assign(message, object(event["delta"]));
      if (event["usage"] !== undefined) message["usage"] = event["usage"];
    }
  }
  if (!message) throw new Error("Missing message.");
  message["content"] = blocks;
  return message;
}

async function readResponse(response: Response): Promise<JsonObject> {
  if (!response.ok) {
    // Do not expose provider bodies, which may echo prompts or credentials.
    await response.body?.cancel();
    throw new Error(`Anthropic request failed (HTTP ${response.status}). History was preserved.`);
  }
  try {
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      return collectStream(await response.text());
    }
    return object(await response.json());
    // oxlint-disable-next-line eslint/preserve-caught-error -- JSON parser errors can expose raw provider response bodies.
  } catch {
    throw new Error("Anthropic returned an invalid JSON response. History was preserved.");
  }
}

export async function supportsCompaction(
  request: Request,
  model: string,
  signal: AbortSignal,
  fetcher = fetch,
): Promise<boolean> {
  const url = new URL(`/v1/models/${encodeURIComponent(model)}`, request.url);
  const response = await fetcher(url, {
    headers: betaHeaders(request.headers),
    signal,
    redirect: "error",
  });
  const data = await readResponse(response);
  const capability = object(object(data["capabilities"])["compaction"]);
  const supported = object(capability["summarize"])["supported"];
  if (typeof supported !== "boolean")
    throw new Error("Anthropic did not report compaction support.");
  return supported;
}

export async function sendSummaryRequest(
  request: Request,
  signal: AbortSignal,
  fetcher = fetch,
): Promise<JsonObject> {
  // Send the final body unchanged: provider wrappers such as pi-black sign it (cch).
  const body = await request.text();
  if (object(JSON.parse(body))["compaction"] === undefined) {
    throw new Error("The provider dropped the compaction request. History was preserved.");
  }
  return readResponse(
    await fetcher(request.url, {
      method: "POST",
      headers: betaHeaders(request.headers),
      body,
      signal,
      redirect: "error",
    }),
  );
}
