// A proxied fetch that fails never puts a credential in the server log or in the
// strictProxy error (open-sse/utils/proxyFetch.js). undici is mocked: these check
// what is logged and retried, not sockets.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("undici", () => {
  class Agent { constructor(options) { this.options = options; } }
  class ProxyAgent { constructor(options) { this.options = options; } }
  return { Agent, ProxyAgent };
});

const fetchMock = vi.fn();
let proxyAwareFetch;
beforeAll(async () => {
  // proxyFetch keeps the fetch it finds at import as the one it calls.
  globalThis.fetch = fetchMock;
  ({ proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js"));
});

const TOKEN = "secret-token-value-0123456789";
const URL = "https://upstream.test/v1/user";
const viaProxy = { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.upstream.test:3128" };
const headerError = () => {
  try { new Headers({ Authorization: `Bearer ${TOKEN}\nmore` }); } catch (err) { return err; }
  throw new Error("Headers accepted a line break");
};
let warn;
beforeEach(() => {
  fetchMock.mockReset();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());
const logged = () => JSON.stringify(warn.mock.calls);

describe("proxyAwareFetch error text", () => {
  it("passes a refused header value on without logging it or retrying direct", async () => {
    const err = headerError();
    fetchMock.mockRejectedValueOnce(err);
    await expect(proxyAwareFetch(URL, { headers: {} }, viaProxy)).rejects.toBe(err);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("redacts a bearer token from the fallback warning", async () => {
    fetchMock.mockRejectedValueOnce(new Error(`proxy said no to Bearer ${TOKEN}`))
      .mockResolvedValueOnce(new Response("{}"));
    expect((await proxyAwareFetch(URL, { headers: {} }, viaProxy)).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logged()).toContain("falling back to direct");
    expect(logged()).not.toContain(TOKEN);
  });

  it("redacts a bearer token from the strictProxy error", async () => {
    fetchMock.mockRejectedValueOnce(new Error(`proxy said no to Bearer ${TOKEN}`));
    const failure = await proxyAwareFetch(URL, { headers: {} }, { ...viaProxy, strictProxy: true }).catch((e) => e);
    expect(failure.message).toContain("strictProxy=true");
    expect(failure.message).not.toContain(TOKEN);
  });
});
