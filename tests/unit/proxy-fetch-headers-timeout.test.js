// A fetch whose own headers budget is at least undici's default headersTimeout
// goes through a dispatcher with undici's timeout off, so the router's timer is
// the one that ends it (open-sse/utils/proxyFetch.js). undici is mocked: these
// check which dispatcher each fetch gets, not sockets.
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

vi.mock("undici", () => {
  class Agent { constructor(options) { this.options = options; } }
  class ProxyAgent { constructor(options) { this.options = options; } }
  return { Agent, ProxyAgent };
});

const fetchMock = vi.fn(async () => new Response("{}"));
let proxyAwareFetch;
let UNDICI_HEADERS_TIMEOUT_MS;

beforeAll(async () => {
  // proxyFetch keeps the fetch it finds at import as the one it calls.
  globalThis.fetch = fetchMock;
  ({ proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js"));
  ({ UNDICI_HEADERS_TIMEOUT_MS } = await import("../../open-sse/config/runtimeConfig.js"));
});

beforeEach(() => fetchMock.mockClear());

const URL = "https://upstream.test/v1/chat/completions";
const dispatcherOf = (call = 0) => fetchMock.mock.calls[call][1].dispatcher;
const viaProxy = { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.upstream.test:3128" };

describe("proxyAwareFetch and undici's headers timeout", () => {
  it("turns undici's headers timeout off for a budget at least as long as it", async () => {
    await proxyAwareFetch(URL, { method: "POST" }, null, { headersTimeoutMs: UNDICI_HEADERS_TIMEOUT_MS });
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

  it("uses a proxy agent with undici's headers timeout off, apart from the proxy's usual one", async () => {
    await proxyAwareFetch(URL, { method: "POST" }, viaProxy, { headersTimeoutMs: UNDICI_HEADERS_TIMEOUT_MS });
    await proxyAwareFetch(URL, { method: "POST" }, viaProxy);

    expect(dispatcherOf(0).options).toEqual({ uri: "http://proxy.upstream.test:3128", headersTimeout: 0 });
    expect(dispatcherOf(1).options).toEqual({ uri: "http://proxy.upstream.test:3128" });
  });

  it("turns it off on the relay path too", async () => {
    await proxyAwareFetch(URL, { method: "POST", headers: {} }, { vercelRelayUrl: "https://relay.upstream.test/" }, { headersTimeoutMs: UNDICI_HEADERS_TIMEOUT_MS });

    expect(fetchMock.mock.calls[0][0]).toBe("https://relay.upstream.test/");
    expect(dispatcherOf(0)?.options).toEqual({ headersTimeout: 0 });
  });
});
