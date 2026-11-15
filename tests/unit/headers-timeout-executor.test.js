// An upstream that sends no response headers in time fails as a 504 after one
// long attempt (upstreamHeadersBudget), not the 502 retries a network error gets.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));
vi.mock("../../open-sse/services/qoderModels.js", () => ({
  getQoderModelConfig: async (_credentials, key) => ({ key, is_reasoning: false, max_output_tokens: 1000, source: "system" }),
  resolveQoderModels: async () => null,
  isQoderPat: () => false,
  resolveQoderCredentials: async (credentials) => credentials,
}));

const { BaseExecutor } = await import("../../open-sse/executors/base.js");
const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
const { QoderExecutor } = await import("../../open-sse/executors/qoder.js");
const { FETCH_CONNECT_TIMEOUT_MS, DEFAULT_RETRY_CONFIG } = await import("../../open-sse/config/runtimeConfig.js");

const MODEL = "big-model";
// One attempt as long as master's four attempts of FETCH_CONNECT_TIMEOUT_MS.
const BUDGET_MS = 4 * FETCH_CONNECT_TIMEOUT_MS;
const A = "https://a.upstream.test/v1";
const B = "https://b.upstream.test/v1";
const creds = { apiKey: "placeholder" };
const ok = () => ({ status: 200, headers: { get: () => "" } });
// Never sends headers: the fetch settles only when its signal aborts.
const hang = (_url, init) => new Promise((_resolve, reject) => {
  init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
});
const isHeadersTimeout = (error) => error?.status === 504 && /no response headers in \d+s/.test(error.message);
const urls = () => fetchMock.mock.calls.map(([url]) => url);

// Runs execute to the end on fake time; returns how long it took and what it settled with.
async function timed(executor, args) {
  const start = Date.now();
  const settled = executor.execute({ model: MODEL, body: {}, credentials: creds, ...args })
    .then((value) => ({ value }), (error) => ({ error }));
  await vi.runAllTimersAsync();
  return { ...(await settled), elapsedMs: Date.now() - start };
}

function endpoint(stream, overrides = { timeout: "5" }) {
  const credentials = { apiKey: "placeholder", providerSpecificData: { baseUrl: "https://upstream.test/v1", overrides } };
  const body = { model: MODEL, messages: [{ role: "user", content: "hi" }], stream };
  return timed(new DefaultExecutor("openai-compatible-chat-acme"), { stream, body, credentials });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("BaseExecutor header timeout", () => {
  it("gives a non-streaming call one attempt as long as four were, then fails it as a 504", async () => {
    fetchMock.mockImplementation(hang);
    const { error, elapsedMs } = await timed(new BaseExecutor("acme", { baseUrl: A }), { stream: false });

    expect(urls()).toEqual([A]);
    expect(elapsedMs).toBe(BUDGET_MS);
    expect(isHeadersTimeout(error)).toBe(true);
    expect(error.message).toContain(`in ${BUDGET_MS / 1000}s (headers timeout, set by 4x FETCH_CONNECT_TIMEOUT_MS)`);
    expect(error.stream).toBe(false);
  });

  it("gives a streaming call one attempt as long as four were", async () => {
    fetchMock.mockImplementation(hang);
    const { error, elapsedMs } = await timed(new BaseExecutor("acme", { baseUrl: A }), { stream: true });

    expect(urls()).toEqual([A]);
    expect(elapsedMs).toBe(BUDGET_MS);
    expect(isHeadersTimeout(error)).toBe(true);
    expect(error.message).toContain("set by UPSTREAM_STREAM_HEADERS_TIMEOUT_MS");
    expect(error.stream).toBe(true);
  });

  it("moves to the next base URL after a header timeout, without retrying the first", async () => {
    fetchMock.mockImplementationOnce(hang).mockResolvedValueOnce(ok());
    const { value, elapsedMs } = await timed(new BaseExecutor("acme", { baseUrls: [A, B] }), { stream: true });

    expect(urls()).toEqual([A, B]);
    expect(value.url).toBe(B);
    expect(elapsedMs).toBe(BUDGET_MS);
  });

  it("fails as a 504 once every base URL timed out, one attempt each", async () => {
    fetchMock.mockImplementation(hang);
    const { error, elapsedMs } = await timed(new BaseExecutor("acme", { baseUrls: [A, B] }), { stream: false });

    expect(urls()).toEqual([A, B]);
    expect(elapsedMs).toBe(2 * BUDGET_MS);
    expect(isHeadersTimeout(error)).toBe(true);
  });

  it("gives a stream on a custom endpoint one attempt of 4x its Timeout setting", async () => {
    fetchMock.mockImplementation(hang);
    const { error, elapsedMs } = await endpoint(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(elapsedMs).toBe(4 * 5000);
    expect(error.message).toContain("set by 4x the endpoint's Timeout setting");
  });

  it("gives a non-streaming call on a custom endpoint one attempt of 4x its Timeout setting", async () => {
    fetchMock.mockImplementation(hang);
    const { error, elapsedMs } = await endpoint(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(elapsedMs).toBe(4 * 5000);
    expect(isHeadersTimeout(error)).toBe(true);
  });

  it("gives a custom endpoint with Retries set one attempt of Timeout x (Retries + 1)", async () => {
    fetchMock.mockImplementation(hang);
    const failFast = await endpoint(true, { timeout: "5", retries: "0" });
    expect(failFast.elapsedMs).toBe(5000);
    expect(failFast.error.message).toContain("set by the endpoint's Timeout setting)");

    fetchMock.mockClear();
    const { elapsedMs } = await endpoint(false, { timeout: "5", retries: "2" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(elapsedMs).toBe(3 * 5000);
  });

  it("treats undici's own headers timeout as a header timeout, without the 502 retries", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed", { cause: Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" }) }));
    const { error } = await timed(new BaseExecutor("acme", { baseUrl: A }), { stream: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(isHeadersTimeout(error)).toBe(true);
    expect(error.message).toContain("set by the HTTP client's own headers timeout");
  });

  it("tells the fetch its headers budget, so undici's own timeout can't end it first", async () => {
    fetchMock.mockResolvedValue(ok());
    await timed(new BaseExecutor("acme", { baseUrl: A }), { stream: true });
    expect(fetchMock.mock.calls[0][3]).toEqual({ headersTimeoutMs: BUDGET_MS });
  });

  it("reports the whole call's headers budget, one budget per base URL", async () => {
    fetchMock.mockResolvedValue(ok());
    const onHeadersBudget = vi.fn();
    await timed(new BaseExecutor("acme", { baseUrls: [A, B, "https://c.upstream.test/v1"] }), { stream: true, onHeadersBudget });
    expect(onHeadersBudget).toHaveBeenCalledWith(3 * BUDGET_MS);
  });

  it("still retries a connection reset on the same URL with the 502 retry config", async () => {
    const reset = new TypeError("fetch failed", { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
    fetchMock.mockRejectedValueOnce(reset).mockResolvedValueOnce(ok());
    const { value, elapsedMs } = await timed(new BaseExecutor("acme", { baseUrl: A }), { stream: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(value.response.status).toBe(200);
    expect(elapsedMs).toBe(DEFAULT_RETRY_CONFIG[502].delayMs);
  });

  it("passes a client hang-up through as an AbortError, without retrying", async () => {
    fetchMock.mockImplementation(hang);
    const client = new AbortController();
    setTimeout(() => client.abort(), 1000);
    const { error } = await timed(new BaseExecutor("acme", { baseUrl: A }), { stream: true, signal: client.signal });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.name).toBe("AbortError");
  });
});

describe("QoderExecutor header timeout", () => {
  it("fails as the same 504 after its own timer", async () => {
    fetchMock.mockImplementation(hang);
    const credentials = { accessToken: "dt-placeholder", providerSpecificData: { userId: "user-a" } };
    const body = { messages: [{ role: "user", content: "hi" }] };
    const qoder = new QoderExecutor();
    const { error, elapsedMs } = await timed(qoder, { model: "qoder/big-model", stream: true, body, credentials });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // qoder's own provider timeout.
    expect(elapsedMs).toBe(120_000);
    expect(isHeadersTimeout(error)).toBe(true);
    expect(error.stream).toBe(true);
  });
});
