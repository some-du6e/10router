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
      expect(fetchMock).toHaveBeenLastCalledWith(url, options);
    }
    expect(proxyAgent).not.toHaveBeenCalled();
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
