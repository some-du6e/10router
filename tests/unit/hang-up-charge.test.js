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
const usageWrites = vi.fn();
vi.mock("@/lib/usageDb.js", async () => {
  const actual = await vi.importActual("@/lib/usageDb.js");
  return { ...actual, saveRequestUsage: (entry, ...rest) => { usageWrites(entry); return actual.saveRequestUsage(entry, ...rest); } };
});
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

async function usageRows(key) {
  return (await (await import("@/lib/db/driver.js")).getAdapter())
    .all("SELECT promptTokens, completionTokens FROM usageHistory WHERE apiKey = ?", [key.key]);
}

// Usage writes this key's request started. A hang-up charge starts its write
// before handleChat returns, so once it has returned this count is final.
const writesFor = (key) => usageWrites.mock.calls.filter(([entry]) => entry?.apiKey === key.key).length;

/** The one usage row the request was charged; a second would be a double charge. */
async function usageRow(key) {
  expect(writesFor(key)).toBe(1);
  await vi.waitFor(async () => { expect((await usageRows(key)).length).toBeGreaterThan(0); }, { timeout: 3000, interval: 20 });
  const rows = await usageRows(key);
  expect(rows).toHaveLength(1);
  return rows[0];
}

/** The request (handleChat has returned) was charged nothing. */
async function expectNoUsage(key) {
  expect(writesFor(key)).toBe(0);
  expect(await usageRows(key)).toEqual([]);
}

// Output tokens the floor gives for `ms` of generation.
const floorFor = (ms) => Math.floor((ms / 1000) * STREAM_ABORT_FLOOR_TPS);

describe("hang-up after the request went upstream", () => {
  it("charges a non-streaming request cut before the upstream answered", async () => {
    const key = await newKey("pre-headers");
    const c = client();
    fetchMock.mockImplementation(c.after(1100, neverAnswers));
    await chat(key, { stream: false }, c.signal);
    const row = await usageRow(key);
    expect(row.promptTokens).toBeGreaterThan(2000);
    // About a second of generation at the floor rate.
    expect(row.completionTokens).toBeGreaterThanOrEqual(floorFor(1000));
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
    expect(row.completionTokens).toBeGreaterThanOrEqual(floorFor(1000));
  });

  it("charges a JSON request to an always-streaming provider, cut mid-stream, from the stream's first byte", async () => {
    const key = await newKey("forced-sse");
    const c = client();
    fetchMock.mockImplementation(c.after(1100, async (_url, init) => stalledBody(init, "text/event-stream", CHAT_CHUNK)));
    await chat(key, { stream: false }, c.signal, "openai/gpt-hangup");
    const row = await usageRow(key);
    expect(row.promptTokens).toBeGreaterThan(2000);
    expect(row.completionTokens).toBeGreaterThanOrEqual(floorFor(1000));
  });

  it("charges a JSON request to Codex from its headers, not from the first delta it read ahead to", async () => {
    const key = await newKey("codex-forced-sse");
    credentialsMock.mockImplementation(async () => ({ ...UPSTREAM_CREDS, apiKey: undefined, accessToken: "upstream-test-token" }));
    const delta = "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n";
    const c = client();
    // Headers at once (reasoning starts), the first output delta 1.5s later,
    // the hang-up 100ms after that. Codex returns only once it has the delta.
    fetchMock.mockImplementation(async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        const timer = setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(delta));
          setTimeout(c.hangUp, 100);
        }, 1500);
        onAbort(init.signal, () => { clearTimeout(timer); controller.error(abortError()); });
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } }));
    await chat(key, { stream: false }, c.signal, "codex/gpt-5.3-codex");
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/responses$/);
    const row = await usageRow(key);
    expect(row.promptTokens).toBeGreaterThan(2000);
    // From the headers: over 1.5s. From when execute() returned it would be about 0.1s.
    expect(row.completionTokens).toBeGreaterThanOrEqual(floorFor(1500));
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
    fetchMock.mockImplementation((_url, init) => answerAfter(3000, init, () => {
      setTimeout(c.hangUp, 50);
      return stalledBody(init, "text/event-stream", CHAT_CHUNK);
    }));
    await chat(key, { stream: false }, c.signal);
    const row = await usageRow(key);
    expect(row.promptTokens).toBeGreaterThan(2000);
    // About 50ms of stream; from dispatch it would be over 3s.
    expect(row.completionTokens).toBeLessThan(floorFor(2000));
  });

  it("a JSON body's floor starts when the request was sent", async () => {
    const key = await newKey("json-dispatch");
    const c = client();
    fetchMock.mockImplementation(c.after(1100, (_url, init) => answerAfter(1000, init, () => stalledBody(init, "application/json", "{\"id\":"))));
    await chat(key, { stream: false }, c.signal);
    const row = await usageRow(key);
    expect(row.completionTokens).toBeGreaterThanOrEqual(floorFor(1000));
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
    expect(row.completionTokens).toBeGreaterThanOrEqual(floorFor(1000));
  });
});

describe("executors that wrap the body", () => {
  // Their own reply stream around the upstream's: a hang-up must still reach
  // the reader as one, not as a short answer.
  async function wrappedHangUp(provider, model, wrap) {
    const key = await newKey(`wrapped-${provider}`);
    const c = client();
    vi.spyOn(getExecutor(provider), "execute").mockImplementationOnce(c.after(1100, async ({ signal }) => ({
      response: await wrap(stalledBody({ signal }, "text/event-stream", null), signal),
      url: "https://upstream.example", headers: {}, transformedBody: null,
    })));
    await chat(key, { stream: false }, c.signal, `${provider}/${model}`);
    return usageRow(key);
  }

  it("charges a Windsurf reply cut mid-generation", async () => {
    const row = await wrappedHangUp("windsurf", "model-a", (upstream) => getExecutor("windsurf").transformToSSE(upstream, "model-a"));
    expect(row.promptTokens).toBeGreaterThan(2000);
    expect(row.completionTokens).toBeGreaterThan(0);
  });

  it("charges a Qoder reply cut mid-generation", async () => {
    const { __test__: qoder } = await import("open-sse/executors/qoder.js");
    const frame = `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify({ choices: [{ index: 0, delta: { content: "partial" } }] }) })}\n`;
    const row = await wrappedHangUp("qoder", "model-a", (_upstream, signal) => qoder.wrapQoderSSE(stalledBody({ signal }, "text/event-stream", frame), "model-a"));
    expect(row.promptTokens).toBeGreaterThan(2000);
    expect(row.completionTokens).toBeGreaterThan(0);
  });
});

describe("work an executor does while the body is read", () => {
  it("can't clear the attempt being read", async () => {
    const key = await newKey("body-phase-report");
    const c = client();
    vi.spyOn(getExecutor("openrouter"), "execute").mockImplementationOnce(c.after(1100, async ({ signal, onUpstreamAttempt }) => {
      // A retry run from inside the body (as Kiro's repair does) backing off.
      setTimeout(() => onUpstreamAttempt?.(0), 50);
      return { response: stalledBody({ signal }, "application/json", "{\"id\":"), url: "https://upstream.example", headers: {}, transformedBody: null };
    }));
    await chat(key, { stream: false }, c.signal);
    const row = await usageRow(key);
    expect(row.promptTokens).toBeGreaterThan(2000);
    expect(row.completionTokens).toBeGreaterThanOrEqual(floorFor(1000));
  });

  it("charges a Kiro hang-up while its repair retry backs off after a 503", async () => {
    const key = await newKey("kiro-repair-backoff");
    credentialsMock.mockImplementation(async () => ({ ...UPSTREAM_CREDS, apiKey: undefined, accessToken: "upstream-test-token", providerSpecificData: { kiroToolCallRepair: true } }));
    const c = client();
    // An empty first answer sends Kiro to a repair retry; that 503s and backs off 2s.
    fetchMock.mockImplementationOnce(async () => new Response(new ReadableStream({ start(ctrl) { ctrl.close(); } }), { status: 200 }));
    fetchMock.mockImplementationOnce(c.after(300, async () => new Response("overloaded", { status: 503 })));
    fetchMock.mockImplementation(neverAnswers);
    await chat(key, { stream: false }, c.signal, "kiro/claude-sonnet-4.5");
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    const row = await usageRow(key);
    expect(row.promptTokens).toBeGreaterThan(2000);
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
    expect(row.completionTokens).toBeGreaterThanOrEqual(floorFor(1000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("floors a hang-up on the retried reply from the retry, not the first attempt", async () => {
    const key = await newKey("refresh-retry-mid-body");
    refreshed();
    const c = client();
    fetchMock.mockImplementationOnce((_url, init) => answerAfter(3000, init, unauthorized));
    fetchMock.mockImplementation(c.after(100, async (_url, init) => stalledBody(init, "application/json", "{\"id\":")));
    await chat(key, { stream: false }, c.signal);
    const row = await usageRow(key);
    expect(row.promptTokens).toBeGreaterThan(2000);
    // About 0.1s from the retry; from the first attempt it would be over 3s.
    expect(row.completionTokens).toBeLessThan(floorFor(2000));
  });

  it("floors a hang-up on a retried SSE reply from when the retry answered", async () => {
    const key = await newKey("refresh-retry-sse");
    refreshed();
    const c = client();
    fetchMock.mockImplementationOnce(async () => unauthorized());
    // The retry answers after 3s; the client leaves 100ms into its stream.
    fetchMock.mockImplementation((_url, init) => answerAfter(3000, init, () => {
      setTimeout(c.hangUp, 100);
      return stalledBody(init, "text/event-stream", CHAT_CHUNK);
    }));
    await chat(key, { stream: false }, c.signal);
    const row = await usageRow(key);
    expect(row.promptTokens).toBeGreaterThan(2000);
    // From the 401's arrival it would be over 3s.
    expect(row.completionTokens).toBeLessThan(floorFor(2000));
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
