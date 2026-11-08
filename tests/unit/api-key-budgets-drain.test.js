// The opt-in drain (STREAM_DRAIN_MAX_MS) on the real chat path: a budgeted
// key whose client hangs up is charged the provider's real final usage.
// Same setup as api-key-budgets-spend.test.js.
//
// A request's cost lands on the key that made it, through the real chat path:
// handleChat → chatCore → the stream/JSON handlers → saveRequestUsage → the
// key's running total. Only account selection and the upstream HTTP call are
// stubbed. Covers a stream the client closes before its final event.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

process.env.STREAM_DRAIN_MAX_MS = "60000";
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-key-drain-"));
const originalDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = tempDir;
delete global._dbAdapter;

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...a) => fetchMock(...a) }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(), logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(), logError: vi.fn(), logOpenAIRequest: vi.fn(), appendConvertedChunk: vi.fn(),
  }),
}));
vi.mock("@/sse/services/auth.js", async () => {
  const actual = await vi.importActual("@/sse/services/auth.js");
  return {
    ...actual,
    getProviderCredentials: async () => ({ connectionId: "conn-spend", connectionName: "acct", apiKey: "upstream-test-key" }),
    markAccountUnavailable: async () => ({ shouldFallback: false, cooldownMs: 0 }),
    clearAccountError: async () => {},
  };
});

const db = await import("@/lib/db/index.js");
const { handleChat } = await import("@/sse/handlers/chat.js");

const MODEL = "openai/gpt-spend";

beforeAll(async () => {
  await db.updateSettings({ requireApiKey: true });
  // $1 per 1M input or output tokens.
  await db.updatePricing({ openai: { "gpt-spend": { input: 1, output: 1 } }, anthropic: { "claude-spend": { input: 1, output: 1 } } });
});

afterAll(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

beforeEach(() => fetchMock.mockReset());

async function newKey(name, limits = {}) {
  const created = await db.createApiKey(name, "machine-spend-0001");
  if (Object.keys(limits).length) await db.updateApiKey(created.id, limits);
  return db.getApiKeyById(created.id);
}

function request(key, body, { endpoint = "/v1/chat/completions", model = MODEL } = {}) {
  const extra = endpoint === "/v1/messages" ? { max_tokens: 64 } : {};
  return new Request(`http://localhost${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.key}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], ...extra, ...body }),
  });
}

const sseEvent = (event, data) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
/** An Anthropic stream cut before message_delta: message_start's output_tokens is the placeholder 1. */
const claudeCutStream = () => openStream([
  sseEvent("message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-spend", content: [], usage: { input_tokens: 1_000_000, output_tokens: 1 } } }),
  sseEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
  sseEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me think about this carefully before answering the question." } }),
  sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
  sseEvent("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
  sseEvent("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Here is a fairly long partial answer that got cut" } }),
  sseEvent("content_block_stop", { type: "content_block_stop", index: 1 }),
  sseEvent("content_block_start", { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "read_file", input: {} } }),
  sseEvent("content_block_delta", { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"path\": \"/some/long/path/to/a/file.txt\"" } }),
]);
const { weighChars, estimateOutputTokens } = await import("open-sse/utils/usageTracking.js");
// What claudeCutStream streams before the cut: thinking, text and tool input.
const CUT_STREAM_OUTPUT = estimateOutputTokens(
  weighChars("Let me think about this carefully before answering the question.")
  + weighChars("Here is a fairly long partial answer that got cut")
  + weighChars("{\"path\": \"/some/long/path/to/a/file.txt\""),
);
const usageRow = async (key) => (await (await import("@/lib/db/driver.js")).getAdapter())
  .get("SELECT promptTokens, completionTokens FROM usageHistory WHERE apiKey = ?", [key.key]);

const encoder = new TextEncoder();
const chunk = (obj) => encoder.encode(`data: ${JSON.stringify(obj)}\n\n`);
const delta = (content) => chunk({ id: "c1", object: "chat.completion.chunk", model: "gpt-spend", choices: [{ index: 0, delta: { content } }] });

/** An upstream SSE body that sends `parts`, then stays open until cancelled. */
function openStream(parts) {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < parts.length) controller.enqueue(parts[i++]);
      else return new Promise(() => {});
    },
  });
}

/** Wait for the async usage write to land on the key. */
async function keyAfterUsage(key, predicate) {
  let current;
  await vi.waitFor(async () => {
    current = await db.getApiKeyById(key.id);
    expect(predicate(current)).toBe(true);
  }, { timeout: 3000, interval: 20 });
  return current;
}

async function readUntil(reader, marker) {
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes(marker)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

describe("opt-in drain on the real chat path", () => {
  it("the pending count drops once per request, even when a drained stream also reaches its end", async () => {
    const pendingFor = () => global._pendingRequests?.byModel?.["claude-spend (anthropic)"] || 0;
    let closeA = null;
    const open = () => {
      let ctrl;
      const body = new ReadableStream({ start(c) { ctrl = c; } });
      fetchMock.mockResolvedValueOnce(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
      closeA ??= () => ctrl.close();
      return (event, data) => ctrl.enqueue(sseEvent(event, data));
    };
    const start = { type: "message_start", message: { id: "m1", type: "message", role: "assistant", model: "claude-spend", content: [], usage: { input_tokens: 10, output_tokens: 1 } } };
    const key = await newKey("pending-once", { budgetUsd: 1000 });

    const pushA = open();
    const resA = await handleChat(request(key, { stream: true }, { endpoint: "/v1/messages", model: "anthropic/claude-spend" }));
    const pushB = open();
    const resB = await handleChat(request(key, { stream: true }, { endpoint: "/v1/messages", model: "anthropic/claude-spend" }));
    pushA("message_start", start);
    pushB("message_start", start);
    const readerA = resA.body.getReader();
    await readUntil(readerA, "message_start");
    expect(pendingFor()).toBe(2);

    await readerA.cancel(); // A hangs up: its pending slot is released, B's stays
    // A's drained upstream then ends on its own (no final usage), which runs
    // the stream's end-of-stream bookkeeping as well.
    pushA("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "more" } });
    closeA();
    await keyAfterUsage(key, (k) => k.requestCount === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(pendingFor()).toBe(1);
    await resB.body.cancel();
  });


  it("a budgeted key's cut Anthropic stream (omitted thinking) is charged exactly the message_delta usage", async () => {
    const key = await newKey("budgeted-drain", { budgetUsd: 1000 });
    let ctrl;
    let upstreamCancelled = false;
    const body = new ReadableStream({ start(c) { ctrl = c; }, cancel() { upstreamCancelled = true; } });
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const push = (event, data) => ctrl.enqueue(sseEvent(event, data));

    const res = await handleChat(request(key, { stream: true }, { endpoint: "/v1/messages", model: "anthropic/claude-spend" }));
    const reader = res.body.getReader();
    push("message_start", { type: "message_start", message: { id: "m1", type: "message", role: "assistant", model: "claude-spend", content: [], usage: { input_tokens: 1_000_000, output_tokens: 1 } } });
    push("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
    push("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "EqQBCgIYAhIM" } });
    push("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "short visible" } });
    await readUntil(reader, "short visible");
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 50));
    expect(upstreamCancelled).toBe(false);

    push("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 750_000 } });
    push("message_stop", { type: "message_stop" });
    const stored = await keyAfterUsage(key, (k) => k.requestCount === 1);
    const row = await usageRow(key);
    expect(row.promptTokens).toBe(1_000_000);
    expect(row.completionTokens).toBe(750_000);
    expect(stored.spentUsd).toBeCloseTo(1.75, 6);
  });

});
