import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { proxyAgent } = vi.hoisted(() => ({ proxyAgent: vi.fn(function (options) { this.options = options; }) }));
vi.mock("undici", () => ({ ProxyAgent: proxyAgent }));

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.resetModules();
  proxyAgent.mockClear();
  for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"]) {
    vi.stubEnv(key, "");
  }
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllEnvs();
});

describe("Provider fetch routing", () => {
  it("uses native fetch for provider hosts formerly intercepted by the IDE proxy", async () => {
    const response = new Response("ok");
    const fetchMock = vi.fn().mockResolvedValue(response);
    globalThis.fetch = fetchMock;
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    const signal = new AbortController().signal;
    const options = { method: "POST", body: "{}", signal };

    for (const host of ["daily-cloudcode-pa.googleapis.com", "api.individual.githubcopilot.com", "q.us-east-1.amazonaws.com", "api2.cursor.sh"]) {
      const url = `https://${host}/chat`;
      expect(await proxyAwareFetch(url, options)).toBe(response);
      // Sent without undici's redirect clone (see upstream-body-memory.test.js).
      expect(fetchMock).toHaveBeenLastCalledWith(url, { ...options, redirect: "error", window: null });
    }
    expect(proxyAgent).not.toHaveBeenCalled();
  });

  it("sends a large text body as a stream of its bytes, with the headers fetch would add", async () => {
    const response = new Response("ok");
    const fetchMock = vi.fn().mockResolvedValue(response);
    globalThis.fetch = fetchMock;
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    const { MEMORY_CONFIG } = await import("../../open-sse/config/runtimeConfig.js");
    const body = "x".repeat(MEMORY_CONFIG.streamedBodyMinChars);
    const url = "https://api.individual.githubcopilot.com/chat";
    expect(await proxyAwareFetch(url, { method: "POST", body, headers: { authorization: "Bearer t" } })).toBe(response);
    const [, init] = fetchMock.mock.lastCall;
    expect(init).toMatchObject({ method: "POST", duplex: "half", redirect: "error", window: null });
    expect(init.body).toBeInstanceOf(ReadableStream);
    expect(Object.fromEntries(init.headers)).toEqual({ authorization: "Bearer t", "content-length": String(body.length), "content-type": "text/plain;charset=UTF-8" });
  });

  it("continues routing providers through a configured outbound proxy", async () => {
    const response = new Response("ok");
    const fetchMock = vi.fn().mockResolvedValue(response);
    globalThis.fetch = fetchMock;
    vi.stubEnv("HTTPS_PROXY", "http://localhost:8080");
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

    expect(await proxyAwareFetch("https://api.individual.githubcopilot.com/chat")).toBe(response);
    expect(proxyAgent).toHaveBeenCalledWith({ uri: "http://localhost:8080" });
    expect(fetchMock.mock.calls[0][1].dispatcher).toBe(proxyAgent.mock.instances[0]);
  });
});
