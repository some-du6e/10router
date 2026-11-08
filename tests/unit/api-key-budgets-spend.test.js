// A request's cost lands on the key that made it, through the real chat path:
// handleChat → chatCore → the stream/JSON handlers → saveRequestUsage → the
// key's running total. Only account selection and the upstream HTTP call are
// stubbed. Covers a stream the client closes before its final event.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-key-spend-"));
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

describe("spend on the real chat path", () => {
  it("a non-streaming request's cost lands on its key", async () => {
    const key = await newKey("json");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      id: "c1", object: "chat.completion", model: "gpt-spend",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000 },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const res = await handleChat(request(key, { stream: false }));
    expect(res.status).toBe(200);
    const stored = await keyAfterUsage(key, (k) => k.requestCount === 1);
    expect(stored.spentUsd).toBeCloseTo(1.5, 6);
  });

  it("a stream the client closes before its final event still costs what it streamed", async () => {
    const key = await newKey("cut-short");
    fetchMock.mockResolvedValueOnce(new Response(openStream([delta("Hello "), delta("there, this is a partial answer")]), {
      status: 200, headers: { "content-type": "text/event-stream" },
    }));

    const res = await handleChat(request(key, { stream: true }));
    expect(res.status).toBe(200);
    const reader = res.body.getReader();
    await readUntil(reader, "partial answer");
    await reader.cancel();

    const stored = await keyAfterUsage(key, (k) => k.requestCount === 1);
    expect(stored.spentUsd).toBeGreaterThan(0);
    const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    const row = adapter.get("SELECT completionTokens FROM usageHistory WHERE apiKey = ?", [key.key]);
    expect(row.completionTokens).toBeGreaterThan(0);
  });

  it("a stream cut short after the upstream reported its input tokens adds an estimate of the output", async () => {
    const key = await newKey("cut-after-input-usage");
    fetchMock.mockResolvedValueOnce(new Response(openStream([
      // Like Anthropic's message_start: input counted up front, output only at the end.
      chunk({ id: "c1", object: "chat.completion.chunk", model: "gpt-spend", choices: [{ index: 0, delta: { role: "assistant" } }], usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } }),
      delta("a long answer that the client stopped reading part way through"),
    ]), { status: 200, headers: { "content-type": "text/event-stream" } }));

    const res = await handleChat(request(key, { stream: true }));
    const reader = res.body.getReader();
    await readUntil(reader, "part way");
    await reader.cancel();

    const stored = await keyAfterUsage(key, (k) => k.requestCount === 1);
    const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    const row = adapter.get("SELECT promptTokens, completionTokens FROM usageHistory WHERE apiKey = ?", [key.key]);
    expect(row.promptTokens).toBe(1_000_000);
    expect(row.completionTokens).toBeGreaterThan(0);
    expect(stored.spentUsd).toBeGreaterThan(1);
  });

  it("an Anthropic stream cut before message_delta on /v1/messages is charged for its text, thinking and tool input", async () => {
    const key = await newKey("claude-passthrough-cut");
    fetchMock.mockResolvedValueOnce(new Response(claudeCutStream(), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const res = await handleChat(request(key, { stream: true }, { endpoint: "/v1/messages", model: "anthropic/claude-spend" }));
    expect(res.status).toBe(200);
    const reader = res.body.getReader();
    await readUntil(reader, "file.txt");
    await reader.cancel();

    await keyAfterUsage(key, (k) => k.requestCount === 1);
    const row = await usageRow(key);
    expect(row.promptTokens).toBe(1_000_000);
    // ~150 streamed characters: far more than the placeholder 1.
    expect(row.completionTokens).toBe(CUT_STREAM_OUTPUT);
  });

  it("the same Anthropic stream translated for an OpenAI client is charged the same way", async () => {
    const key = await newKey("claude-translate-cut");
    fetchMock.mockResolvedValueOnce(new Response(claudeCutStream(), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const res = await handleChat(request(key, { stream: true }, { model: "anthropic/claude-spend" }));
    expect(res.status).toBe(200);
    const reader = res.body.getReader();
    await readUntil(reader, "file.txt");
    await reader.cancel();

    await keyAfterUsage(key, (k) => k.requestCount === 1);
    const row = await usageRow(key);
    expect(row.promptTokens).toBe(1_000_000);
    expect(row.completionTokens).toBe(CUT_STREAM_OUTPUT);
  });

  it("a tool-call-only stream cut before its finish chunk still charges input and the tool arguments", async () => {
    const key = await newKey("tool-only-cut");
    const toolDelta = (args, extra = {}) => chunk({ id: "c1", object: "chat.completion.chunk", model: "gpt-spend", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...extra, function: { arguments: args } }] } }] });
    fetchMock.mockResolvedValueOnce(new Response(openStream([
      toolDelta("", { id: "call_1", type: "function", function: { name: "read_file", arguments: "" } }),
      toolDelta("{\"path\": \"/a/fairly/long/path/to/some/file/that/was/being/read.txt\""),
    ]), { status: 200, headers: { "content-type": "text/event-stream" } }));

    const res = await handleChat(request(key, { stream: true }));
    const reader = res.body.getReader();
    await readUntil(reader, "read.txt");
    await reader.cancel();

    const stored = await keyAfterUsage(key, (k) => k.requestCount === 1);
    const row = await usageRow(key);
    expect(row.promptTokens).toBeGreaterThan(0);
    expect(row.completionTokens).toBeGreaterThan(5);
    expect(stored.spentUsd).toBeGreaterThan(0);
  });

  it("with the drain off (the default), a budgeted key's hang-up drops the upstream about 500 ms later", async () => {
    const key = await newKey("budgeted-no-drain", { budgetUsd: 1000 });
    let ctrl;
    let upstreamCancelledAt = null;
    const body = new ReadableStream({ start(c) { ctrl = c; }, cancel() { upstreamCancelledAt = Date.now(); } });
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const res = await handleChat(request(key, { stream: true }, { endpoint: "/v1/messages", model: "anthropic/claude-spend" }));
    const reader = res.body.getReader();
    ctrl.enqueue(sseEvent("message_start", { type: "message_start", message: { id: "m1", type: "message", role: "assistant", model: "claude-spend", content: [], usage: { input_tokens: 1000, output_tokens: 1 } } }));
    ctrl.enqueue(sseEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "visible" } }));
    await readUntil(reader, "visible");
    const hungUpAt = Date.now();
    await reader.cancel();
    await vi.waitFor(() => expect(upstreamCancelledAt).not.toBeNull(), { timeout: 2000 });
    expect(upstreamCancelledAt - hungUpAt).toBeLessThan(1000);
    await keyAfterUsage(key, (k) => k.requestCount === 1);
  });

  it("a non-streaming request over a forced stream with no usage is still charged and recorded", async () => {
    const { handleChatCore } = await import("open-sse/handlers/chatCore.js");
    const key = await newKey("forced-stream-no-usage");
    const provider = "openai-compatible-chat-forced";
    await db.updatePricing({ [provider]: { "gpt-forced": { input: 1, output: 1 } } });
    fetchMock.mockResolvedValueOnce(new Response(
      [delta("a reply with no usage anywhere"), chunk({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }), "data: [DONE]\n\n"]
        .map((p) => (typeof p === "string" ? p : new TextDecoder().decode(p))).join(""),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    const body = { model: "gpt-forced", stream: false, messages: [{ role: "user", content: "hi ".repeat(400) }] };
    const result = await handleChatCore({
      body, modelInfo: { provider, model: "gpt-forced" }, apiKey: key.key, connectionId: "conn-forced",
      credentials: { apiKey: "upstream-test-key", providerSpecificData: { baseUrl: "https://forced.example.test/v1", overrides: { stream: "always" } } },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: { accept: "application/json" } },
    });
    expect(result.success).toBe(true);
    const stored = await keyAfterUsage(key, (k) => k.requestCount === 1);
    expect(stored.spentUsd).toBeGreaterThan(0);
    const row = await usageRow(key);
    expect(row.promptTokens).toBeGreaterThan(0);
    expect(row.completionTokens).toBeGreaterThan(0);
  });

  it("asks the official OpenAI provider, and no other, for its usage chunk", async () => {
    const { DefaultExecutor } = await import("open-sse/executors/default.js");
    const req = { model: "gpt-x", stream: true, messages: [{ role: "user", content: "hi" }] };
    expect(new DefaultExecutor("openai").transformRequest("gpt-x", { ...req }, true, {}).stream_options).toEqual({ include_usage: true });
    expect(new DefaultExecutor("openai-compatible-chat-other").transformRequest("gpt-x", { ...req }, true, {}).stream_options).toBeUndefined();
    // A non-streaming body never gets stream_options (OpenAI 400s on it), even
    // though a forceStream provider passes stream = true for it.
    const { stream: _omit, ...noStreamField } = req;
    expect(new DefaultExecutor("openai").transformRequest("gpt-x", { ...req, stream: false }, true, {}).stream_options).toBeUndefined();
    expect(new DefaultExecutor("openai").transformRequest("gpt-x", { ...noStreamField }, true, {}).stream_options).toBeUndefined();
  });

  it("a stream closed after its final event is counted once, at the reported usage", async () => {
    const key = await newKey("terminal-then-cancel");
    fetchMock.mockResolvedValueOnce(new Response(openStream([
      delta("done answer"),
      chunk({ id: "c1", object: "chat.completion.chunk", model: "gpt-spend", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2_000_000, completion_tokens: 0 } }),
      encoder.encode("data: [DONE]\n\n"),
    ]), { status: 200, headers: { "content-type": "text/event-stream" } }));

    const res = await handleChat(request(key, { stream: true }));
    const reader = res.body.getReader();
    await readUntil(reader, "[DONE]");
    await reader.cancel();

    const stored = await keyAfterUsage(key, (k) => k.requestCount >= 1);
    // Give a second write the chance to land before checking there was none.
    await new Promise((r) => setTimeout(r, 200));
    const final = await db.getApiKeyById(key.id);
    expect(final.requestCount).toBe(1);
    expect(stored.spentUsd).toBeCloseTo(2, 6);
    expect(final.spentUsd).toBeCloseTo(2, 6);
  });
});
