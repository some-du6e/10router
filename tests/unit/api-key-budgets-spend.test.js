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
  await db.updatePricing({ openai: { "gpt-spend": { input: 1, output: 1 } } });
});

afterAll(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

beforeEach(() => fetchMock.mockReset());

async function newKey(name) {
  const created = await db.createApiKey(name, "machine-spend-0001");
  return db.getApiKeyById(created.id);
}

function request(key, body) {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.key}` },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], ...body }),
  });
}

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
