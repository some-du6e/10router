// A client that hangs up on a request while an upstream attempt is in flight
// is still charged, through the real chat path: handleChat → chatCore →
// handlers → saveRequestUsage. Only account selection and the upstream HTTP
// call are stubbed (plus, where noted, one executor method).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

// Each test waits on real timers (the floor is time-based), up to a 2s retry backoff.
vi.setConfig({ testTimeout: 20000 });

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-hang-up-"));
const originalDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = tempDir;
delete global._dbAdapter;

const fetchMock = vi.fn();
const UPSTREAM_CREDS = { connectionId: "conn-hangup", connectionName: "acct", apiKey: "upstream-test-key" };
const credentialsMock = vi.fn(async () => ({ ...UPSTREAM_CREDS }));
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
    getProviderCredentials: (...a) => credentialsMock(...a),
    markAccountUnavailable: async () => ({ shouldFallback: false, cooldownMs: 0 }),
    clearAccountError: async () => {},
  };
});

const db = await import("@/lib/db/index.js");
const { handleChat } = await import("@/sse/handlers/chat.js");
const { hangUpUsage, sentOutputCap, floorTokens } = await import("open-sse/utils/hangUpCharge.js");
const { estimateBillingInputTokens } = await import("open-sse/utils/usageTracking.js");
const { STREAM_ABORT_FLOOR_TPS } = await import("open-sse/config/runtimeConfig.js");
const { getExecutor } = await import("open-sse/executors/index.js");

const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  await db.updateSettings({ requireApiKey: true });
  await db.updatePricing({
    openrouter: { "gpt-hangup": { input: 1, output: 1 } },
    openai: { "gpt-hangup": { input: 1, output: 1 } },
    codex: { "gpt-5.3-codex": { input: 1, output: 1 } },
  });
});

afterAll(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

beforeEach(() => {
  fetchMock.mockReset();
  credentialsMock.mockReset();
  credentialsMock.mockImplementation(async () => ({ ...UPSTREAM_CREDS }));
});
afterEach(() => { vi.restoreAllMocks(); });

async function newKey(name) {
  const created = await db.createApiKey(name, "machine-hangup-0001");
  return db.getApiKeyById(created.id);
}

// openrouter is fetched the way the client asked; openai and codex are always fetched as a stream.
function request(key, body, signal, model = "openrouter/gpt-hangup") {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.key}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi ".repeat(4000) }], ...body }),
  });
}

const chat = (key, body, signal, model) => handleChat(request(key, body, signal, model)).catch(() => null);

/**
 * A client that hangs up `ms` after an upstream call it wraps was made, so the
 * timing doesn't depend on how long the request took to get there.
 */
function client() {
  const ctrl = new AbortController();
  const after = (ms, impl) => (...args) => {
    setTimeout(() => ctrl.abort(), ms);
    return impl(...args);
  };
  return { signal: ctrl.signal, after, hangUp: () => ctrl.abort() };
}

/** Runs `fn` once the signal is aborted, at once when it already was. */
const onAbort = (signal, fn) => {
  if (signal.aborted) return fn();
  signal.addEventListener("abort", fn, { once: true });
};

/** The upstream never answers; its fetch rejects on abort, like real fetch. */
const neverAnswers = (_url, init) => new Promise((_, reject) => onAbort(init.signal, () => reject(abortError())));

/** A 200 whose body sends `first` and then stalls until the request is aborted. */
const stalledBody = (init, contentType, first) => new Response(new ReadableStream({
  start(controller) {
    if (first) controller.enqueue(new TextEncoder().encode(first));
    onAbort(init.signal, () => controller.error(abortError()));
  },
}), { status: 200, headers: { "content-type": contentType } });

/** Waits `ms` like an upstream thinking before its headers, failing on abort. */
const answerAfter = (ms, init, make) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => resolve(make()), ms);
  onAbort(init.signal, () => { clearTimeout(timer); reject(abortError()); });
});

const CHAT_CHUNK = "data: {\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"}}]}\n\n";

async function usageRowNow(key) {
  return (await (await import("@/lib/db/driver.js")).getAdapter())
    .get("SELECT promptTokens, completionTokens FROM usageHistory WHERE apiKey = ?", [key.key]);
}

async function usageRow(key) {
  let row;
  await vi.waitFor(async () => {
    row = await usageRowNow(key);
    expect(row).toBeTruthy();
  }, { timeout: 3000, interval: 20 });
  return row;
}

async function expectNoUsage(key) {
  await sleep(300);
  expect(await usageRowNow(key)).toBeFalsy();
}

describe("hang-up after the request went upstream", () => {
  it("charges a non-streaming request cut before the upstream answered", async () => {
    const key = await newKey("pre-headers");
    const c = client();
    fetchMock.mockImplementation(c.after(1100, neverAnswers));
    await chat(key, { stream: false }, c.signal);
    const row = await usageRow(key);
    expect(row.promptTokens).toBeGreaterThan(2000);
    // About a second of generation at the floor rate.
    expect(row.completionTokens).toBeGreaterThan(100);
    const stored = await db.getApiKeyById(key.id);
    expect(stored.requestCount).toBe(1);
    expect(stored.spentUsd).toBeGreaterThan(0);
  });

  it("charges a non-streaming request cut while its JSON body was read", async () => {
    const key = await newKey("mid-body");
    const c = client();
    fetchMock.mockImplementation(c.after(100, async (_url, init) => stalledBody(init, "application/json", "{\"id\":\"c1\",\"choices\":[")));
    await chat(key, { stream: false }, c.signal);
    const row = await usageRow(key);
    expect(row.promptTokens).toBeGreaterThan(2000);
  });

  it("charges a non-streaming request whose upstream answered with an SSE body, cut mid-body", async () => {
    const key = await newKey("json-client-sse-body");
    const c = client();
    fetchMock.mockImplementation(c.after(1100, async (_url, init) => stalledBody(init, "text/event-stream", CHAT_CHUNK)));
    await chat(key, { stream: false }, c.signal);
    const row = await usageRow(key);
    expect(row.promptTokens).toBeGreaterThan(2000);
    expect(row.completionTokens).toBeGreaterThan(100);
  });

  it("charges a JSON request to an always-streaming provider, cut mid-stream, from the stream's first byte", async () => {
    const key = await newKey("forced-sse");
    const c = client();
    fetchMock.mockImplementation(c.after(1100, async (_url, init) => stalledBody(init, "text/event-stream", CHAT_CHUNK)));
    await chat(key, { stream: false }, c.signal, "openai/gpt-hangup");
    const row = await usageRow(key);
    expect(row.promptTokens).toBeGreaterThan(2000);
    expect(row.completionTokens).toBeGreaterThan(100);
  });

  it("charges a JSON request to Codex cut after its first output delta", async () => {
    const key = await newKey("codex-forced-sse");
    credentialsMock.mockImplementation(async () => ({ ...UPSTREAM_CREDS, apiKey: undefined, accessToken: "upstream-test-token" }));
    const delta = "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n";
    const c = client();
    fetchMock.mockImplementation(c.after(1100, async (_url, init) => stalledBody(init, "text/event-stream", delta)));
    await chat(key, { stream: false }, c.signal, "codex/gpt-5.3-codex");
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/responses$/);
    const row = await usageRow(key);
    expect(row.promptTokens).toBeGreaterThan(2000);
    // Codex reads ahead to that delta before returning; the floor starts when its fetch returned.
    expect(row.completionTokens).toBeGreaterThan(100);
  });

  it("charges a stream cut before its first byte for its input only", async () => {
    const key = await newKey("stream-pre-headers");
    const c = client();
    fetchMock.mockImplementation(c.after(300, neverAnswers));
    await chat(key, { stream: true }, c.signal);
    const row = await usageRow(key);
    expect(row.promptTokens).toBeGreaterThan(2000);
    expect(row.completionTokens).toBe(0);
  });

  it("caps the output at the max_tokens sent upstream", async () => {
    const key = await newKey("capped");
    const c = client();
    fetchMock.mockImplementation(c.after(1100, neverAnswers));
    await chat(key, { stream: false, max_tokens: 5 }, c.signal);
    const row = await usageRow(key);
    expect(row.completionTokens).toBeGreaterThan(0);
    expect(row.completionTokens).toBeLessThanOrEqual(5);
  });
});

describe("where the time floor starts", () => {
  it("an SSE body's floor starts at its first byte, not when the request was sent", async () => {
    const key = await newKey("sse-first-byte");
    const c = client();
    fetchMock.mockImplementation((_url, init) => answerAfter(1000, init, () => {
      setTimeout(c.hangUp, 50);
      return stalledBody(init, "text/event-stream", CHAT_CHUNK);
    }));
    await chat(key, { stream: false }, c.signal);
    const row = await usageRow(key);
    expect(row.promptTokens).toBeGreaterThan(2000);
    expect(row.completionTokens).toBeLessThan(50);
  });

  it("a JSON body's floor starts when the request was sent", async () => {
    const key = await newKey("json-dispatch");
    const c = client();
    fetchMock.mockImplementation(c.after(1100, (_url, init) => answerAfter(1000, init, () => stalledBody(init, "application/json", "{\"id\":"))));
    await chat(key, { stream: false }, c.signal);
    const row = await usageRow(key);
    expect(row.completionTokens).toBeGreaterThan(100);
  });
});

describe("no attempt in flight, no charge", () => {
  it("charges nothing when the client left before the request went upstream", async () => {
    const key = await newKey("left-before-dispatch");
    const c = client();
    credentialsMock.mockImplementationOnce(async () => { c.hangUp(); return { ...UPSTREAM_CREDS }; });
    fetchMock.mockImplementation(neverAnswers);
    await chat(key, { stream: false }, c.signal);
    await expectNoUsage(key);
  });

  it("charges nothing for a hang-up while backing off after a 503", async () => {
    const key = await newKey("backoff");
    const c = client();
    // The 503 retry waits 2s; the client leaves half a second into it.
    fetchMock.mockImplementationOnce(c.after(500, async () => new Response("overloaded", { status: 503 })));
    fetchMock.mockImplementation(neverAnswers);
    await chat(key, { stream: false }, c.signal);
    await expectNoUsage(key);
  });

  it("charges an executor that reports the hang-up as an error response", async () => {
    // Like Cursor or Trae, which buffer through generation and answer 500/502 when cut.
    const key = await newKey("synthesized-error");
    const c = client();
    vi.spyOn(getExecutor("openrouter"), "execute").mockImplementationOnce(c.after(1100, ({ signal }) => new Promise((resolve) => {
      onAbort(signal, () => resolve({ response: new Response("{\"error\":\"aborted\"}", { status: 500 }), url: "https://upstream.example", headers: {}, transformedBody: null }));
    })));
    // Streaming too: such an executor generates before its stream starts.
    await chat(key, { stream: true }, c.signal);
    const row = await usageRow(key);
    expect(row.promptTokens).toBeGreaterThan(2000);
    expect(row.completionTokens).toBeGreaterThan(100);
  });
});

describe("hang-up around a token refresh", () => {
  const unauthorized = () => new Response("{\"error\":\"expired\"}", { status: 401 });
  const refreshed = () => vi.spyOn(getExecutor("openrouter"), "refreshCredentials").mockResolvedValue({ accessToken: "refreshed-token" });

  it("charges a hang-up while the retry after the refresh is in flight", async () => {
    const key = await newKey("refresh-retry-in-flight");
    refreshed();
    const c = client();
    fetchMock.mockImplementationOnce(async () => unauthorized());
    fetchMock.mockImplementation(c.after(1100, neverAnswers));
    await chat(key, { stream: false }, c.signal);
    const row = await usageRow(key);
    expect(row.promptTokens).toBeGreaterThan(2000);
    expect(row.completionTokens).toBeGreaterThan(100);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("floors a hang-up on the retried reply from the retry, not the first attempt", async () => {
    const key = await newKey("refresh-retry-mid-body");
    refreshed();
    const c = client();
    fetchMock.mockImplementationOnce((_url, init) => answerAfter(1000, init, unauthorized));
    fetchMock.mockImplementation(c.after(100, async (_url, init) => stalledBody(init, "application/json", "{\"id\":")));
    await chat(key, { stream: false }, c.signal);
    const row = await usageRow(key);
    expect(row.promptTokens).toBeGreaterThan(2000);
    // About 0.1s from the retry; from the first attempt it would be over 1.1s.
    expect(row.completionTokens).toBeLessThan(50);
  });
});

describe("hangUpUsage", () => {
  const body = { messages: [{ role: "user", content: "hello there" }] };

  it("estimates input from the body and output from the time floor, capped by what was sent upstream", () => {
    const now = 10_000;
    const free = hangUpUsage({ body, floorFrom: now - 2000, now });
    expect(free.prompt_tokens).toBe(estimateBillingInputTokens(body));
    expect(free.completion_tokens).toBe(2 * STREAM_ABORT_FLOOR_TPS);
    expect(hangUpUsage({ body, sentBody: JSON.stringify({ max_tokens: 50 }), floorFrom: now - 2000, now }).completion_tokens).toBe(50);
    expect(hangUpUsage({ body, floorFrom: null, now }).completion_tokens).toBe(0);
  });

  it("ignores the client's cap when the body sent upstream has none", () => {
    const now = 10_000;
    const client = { ...body, max_tokens: 50 };
    expect(hangUpUsage({ body: client, floorFrom: now - 2000, now }).completion_tokens).toBe(50);
    expect(hangUpUsage({ body: client, sentBody: { input: [] }, floorFrom: now - 2000, now }).completion_tokens).toBe(2 * STREAM_ABORT_FLOOR_TPS);
  });

  it("shares its cap and floor with the stream path", () => {
    expect(sentOutputCap(null, { max_tokens: 7 })).toBe(7);
    expect(sentOutputCap("{\"generationConfig\":{\"maxOutputTokens\":9}}", { max_tokens: 7 })).toBe(9);
    expect(sentOutputCap("not json", { max_tokens: 7 })).toBeNull();
    expect(floorTokens(1000, 3000)).toBe(2 * STREAM_ABORT_FLOOR_TPS);
    expect(floorTokens(0, 3000)).toBe(0);
    expect(floorTokens(3000, 1000)).toBe(0);
  });
});
