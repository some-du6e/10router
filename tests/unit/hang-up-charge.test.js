// A client that hangs up on a request after it went upstream is still charged,
// through the real chat path: handleChat → chatCore → handlers → saveRequestUsage.
// Only account selection and the upstream HTTP call are stubbed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-hang-up-"));
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
    getProviderCredentials: async () => ({ connectionId: "conn-hangup", connectionName: "acct", apiKey: "upstream-test-key" }),
    markAccountUnavailable: async () => ({ shouldFallback: false, cooldownMs: 0 }),
    clearAccountError: async () => {},
  };
});

const db = await import("@/lib/db/index.js");
const { handleChat } = await import("@/sse/handlers/chat.js");
const { hangUpUsage } = await import("open-sse/utils/hangUpCharge.js");
const { estimateBillingInputTokens } = await import("open-sse/utils/usageTracking.js");

const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });

beforeAll(async () => {
  await db.updateSettings({ requireApiKey: true });
  await db.updatePricing({ openrouter: { "gpt-hangup": { input: 1, output: 1 } }, openai: { "gpt-hangup": { input: 1, output: 1 } } });
});

afterAll(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

beforeEach(() => { fetchMock.mockReset(); });

async function newKey(name) {
  const created = await db.createApiKey(name, "machine-hangup-0001");
  return db.getApiKeyById(created.id);
}

// openrouter answers JSON for a JSON client; openai is always fetched as a stream.
function request(key, body, signal, model = "openrouter/gpt-hangup") {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.key}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi ".repeat(4000) }], ...body }),
  });
}

/** The upstream never answers; its fetch rejects when the request is aborted, like real fetch. */
const neverAnswers = (_url, init) => new Promise((_, reject) => {
  init.signal.addEventListener("abort", () => reject(abortError()), { once: true });
});

async function usageRow(key) {
  let row;
  await vi.waitFor(async () => {
    row = (await (await import("@/lib/db/driver.js")).getAdapter())
      .get("SELECT promptTokens, completionTokens FROM usageHistory WHERE apiKey = ?", [key.key]);
    expect(row).toBeTruthy();
  }, { timeout: 3000, interval: 20 });
  return row;
}

async function hangUpAfter(ms, run) {
  const ctrl = new AbortController();
  const pending = run(ctrl.signal);
  await new Promise((r) => setTimeout(r, ms));
  ctrl.abort();
  return pending;
}

describe("hang-up after the request went upstream", () => {
  it("charges a non-streaming request cut before the upstream answered", async () => {
    const key = await newKey("pre-headers");
    fetchMock.mockImplementation(neverAnswers);
    await hangUpAfter(1100, (signal) => handleChat(request(key, { stream: false }, signal)).catch(() => null));
    const row = await usageRow(key);
    expect(row.promptTokens).toBeGreaterThan(2000);
    // About a second of generation at the floor rate.
    expect(row.completionTokens).toBeGreaterThan(0);
    const stored = await db.getApiKeyById(key.id);
    expect(stored.requestCount).toBe(1);
    expect(stored.spentUsd).toBeGreaterThan(0);
  });

  it("charges a non-streaming request cut while its JSON body was read", async () => {
    const key = await newKey("mid-body");
    fetchMock.mockImplementation(async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{\"id\":\"c1\",\"choices\":["));
        init.signal.addEventListener("abort", () => controller.error(abortError()), { once: true });
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await hangUpAfter(100, (signal) => handleChat(request(key, { stream: false }, signal)).catch(() => null));
    const row = await usageRow(key);
    expect(row.promptTokens).toBeGreaterThan(2000);
  });

  it("charges a JSON request to an always-streaming provider, cut mid-stream, from the stream's first byte", async () => {
    const key = await newKey("forced-sse");
    fetchMock.mockImplementation(async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: {\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"}}]}\n\n"));
        init.signal.addEventListener("abort", () => controller.error(abortError()), { once: true });
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } }));
    await hangUpAfter(1100, (signal) => handleChat(request(key, { stream: false }, signal, "openai/gpt-hangup")).catch(() => null));
    const row = await usageRow(key);
    expect(row.promptTokens).toBeGreaterThan(2000);
    expect(row.completionTokens).toBeGreaterThan(0);
  });

  it("charges a stream cut before its first byte for its input only", async () => {
    const key = await newKey("stream-pre-headers");
    fetchMock.mockImplementation(neverAnswers);
    await hangUpAfter(300, (signal) => handleChat(request(key, { stream: true }, signal)).catch(() => null));
    const row = await usageRow(key);
    expect(row.promptTokens).toBeGreaterThan(2000);
    expect(row.completionTokens).toBe(0);
  });
});

describe("hangUpUsage", () => {
  const body = { messages: [{ role: "user", content: "hello there" }] };

  it("estimates input from the body and output from the time floor, capped by what was sent upstream", () => {
    const now = 10_000;
    const free = hangUpUsage({ body, floorFrom: now - 2000, now });
    expect(free.prompt_tokens).toBe(estimateBillingInputTokens(body));
    expect(free.completion_tokens).toBe(300);
    expect(hangUpUsage({ body, sentBody: JSON.stringify({ max_tokens: 50 }), floorFrom: now - 2000, now }).completion_tokens).toBe(50);
    expect(hangUpUsage({ body, floorFrom: null, now }).completion_tokens).toBe(0);
  });
});
