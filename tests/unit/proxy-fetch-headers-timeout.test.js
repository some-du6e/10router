// A fetch whose own headers budget is at least undici's default headersTimeout
// goes through a dispatcher with undici's timeout off, so the router's timer is
// the one that ends it (open-sse/utils/proxyFetch.js). undici is mocked: these
// check which dispatcher each fetch gets, not sockets.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

vi.mock("undici", () => {
  class Agent { constructor(options) { this.options = options; } }
  class ProxyAgent { constructor(options) { this.options = options; } }
  return { Agent, ProxyAgent };
});

const fetchMock = vi.fn(async () => new Response("{}"));
let proxyAwareFetch;
let isUndiciHeadersTimeout;
let UNDICI_HEADERS_TIMEOUT_MS;

beforeAll(async () => {
  // proxyFetch keeps the fetch it finds at import as the one it calls.
  globalThis.fetch = fetchMock;
  ({ proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js"));
  ({ isUndiciHeadersTimeout } = await import("../../open-sse/utils/headersTimeout.js"));
  ({ UNDICI_HEADERS_TIMEOUT_MS } = await import("../../open-sse/config/runtimeConfig.js"));
});

const PROXY_ENV = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"];
let savedEnv;
const FETCH_TAP = Symbol.for("10router.fetchTap");
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response("{}"));
  savedEnv = Object.fromEntries(PROXY_ENV.map((name) => [name, process.env[name]]));
  for (const name of PROXY_ENV) delete process.env[name];
});
afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  delete globalThis[FETCH_TAP];
});

const URL = "https://upstream.test/v1/chat/completions";
const LONG = () => ({ headersTimeoutMs: UNDICI_HEADERS_TIMEOUT_MS });
const dispatcherOf = (call = 0) => fetchMock.mock.calls[call][1].dispatcher;
const viaProxy = { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.upstream.test:3128" };
const viaSocks = { connectionProxyEnabled: true, connectionProxyUrl: "socks5://proxy.upstream.test:1080" };
const headersTimeoutError = () => new TypeError("fetch failed", { cause: Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" }) });

describe("proxyAwareFetch and undici's headers timeout", () => {
  it("turns undici's headers timeout off for a budget at least as long as it", async () => {
    await proxyAwareFetch(URL, { method: "POST" }, null, LONG());
    await proxyAwareFetch(URL, { method: "POST" }, null, { headersTimeoutMs: 2 * UNDICI_HEADERS_TIMEOUT_MS });

    expect(dispatcherOf(0)?.options).toEqual({ headersTimeout: 0 });
    expect(dispatcherOf(1)).toBe(dispatcherOf(0));
  });

  it("leaves a shorter budget, or a fetch without one, on the default dispatcher", async () => {
    await proxyAwareFetch(URL, { method: "POST" }, null, { headersTimeoutMs: UNDICI_HEADERS_TIMEOUT_MS - 1 });
    await proxyAwareFetch(URL, { method: "POST" });

    expect(dispatcherOf(0)).toBeUndefined();
    expect(dispatcherOf(1)).toBeUndefined();
  });

  it("uses a cached proxy agent with undici's headers timeout off, apart from the proxy's usual one", async () => {
    await proxyAwareFetch(URL, { method: "POST" }, viaProxy, LONG());
    await proxyAwareFetch(URL, { method: "POST" }, viaProxy);
    await proxyAwareFetch(URL, { method: "POST" }, viaProxy, LONG());

    expect(dispatcherOf(0).options).toEqual({ uri: "http://proxy.upstream.test:3128", headersTimeout: 0 });
    expect(dispatcherOf(1).options).toEqual({ uri: "http://proxy.upstream.test:3128" });
    expect(dispatcherOf(2)).toBe(dispatcherOf(0));
  });

  it("keeps the long dispatcher when a failing proxy falls back to direct", async () => {
    fetchMock.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    await proxyAwareFetch(URL, { method: "POST" }, viaProxy, LONG());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(dispatcherOf(1)?.options).toEqual({ headersTimeout: 0 });
  });

  it("turns it off on the relay path too", async () => {
    await proxyAwareFetch(URL, { method: "POST", headers: {} }, { vercelRelayUrl: "https://relay.upstream.test/" }, LONG());

    expect(fetchMock.mock.calls[0][0]).toBe("https://relay.upstream.test/");
    expect(dispatcherOf(0)?.options).toEqual({ headersTimeout: 0 });
  });

  it("turns it off for custom endpoints, whose fetches go through the request-log tap", async () => {
    const seen = { done: vi.fn((response) => response), fail: vi.fn() };
    globalThis[FETCH_TAP] = { start: vi.fn(() => seen) };
    await proxyAwareFetch(URL, { method: "POST" }, null, LONG());

    expect(globalThis[FETCH_TAP].start).toHaveBeenCalledTimes(1);
    expect(seen.done).toHaveBeenCalledTimes(1);
    expect(dispatcherOf(0)?.options).toEqual({ headersTimeout: 0 });
  });
});

describe("undici's headers timeout through a proxy", () => {
  // undici's SOCKS agent keeps its own 300s limit, whatever the pool options say.
  it("is a header timeout, not a proxy failure: no retry direct", async () => {
    fetchMock.mockRejectedValueOnce(headersTimeoutError());
    const error = await proxyAwareFetch(URL, { method: "POST" }, viaSocks, LONG()).catch((e) => e);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(isUndiciHeadersTimeout(error)).toBe(true);
  });

  it("keeps the cause on a strict proxy's own failure", async () => {
    const refused = new Error("connect ECONNREFUSED");
    fetchMock.mockRejectedValueOnce(refused);
    const error = await proxyAwareFetch(URL, { method: "POST" }, { ...viaSocks, strictProxy: true }).catch((e) => e);

    expect(error.message).toContain("strictProxy=true");
    expect(error.cause).toBe(refused);
  });

  it("is recognised on the error, its cause, or a wrapper's cause", () => {
    const own = Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" });
    expect(isUndiciHeadersTimeout(own)).toBe(true);
    expect(isUndiciHeadersTimeout(headersTimeoutError())).toBe(true);
    expect(isUndiciHeadersTimeout(new Error("strict proxy failed", { cause: headersTimeoutError() }))).toBe(true);
    expect(isUndiciHeadersTimeout(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }))).toBe(false);
  });
});
