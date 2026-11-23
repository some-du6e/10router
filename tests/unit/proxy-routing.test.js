import { afterEach, describe, expect, it, vi } from "vitest";
import { PROXY_DIRECT, resolveProxyChain, toProxyOptions } from "../../src/lib/network/proxyRouting.ts";

const pools = {
  eu: { id: "eu", name: "Residential EU", proxyUrl: "http://eu.proxy.test:3128", isActive: true, strictProxy: true },
  sg: { id: "sg", name: "Datacenter SG", proxyUrl: "socks5://sg.proxy.test:1080", isActive: true, strictProxy: false },
  off: { id: "off", name: "Old office VPN", proxyUrl: "http://10.0.4.20:8888", isActive: false },
  relay: { id: "relay", name: "Edge relay", proxyUrl: "https://relay.test", isActive: true, type: "cloudflare" },
};

describe("resolveProxyChain", () => {
  it("uses the most specific layer that sets something", () => {
    const r = resolveProxyChain({ account: { proxyPoolId: "eu" }, provider: "sg", global: "sg", pools });
    expect(r).toMatchObject({ layer: "account", source: "pool", connectionProxyUrl: "http://eu.proxy.test:3128", strictProxy: true });
  });

  it("falls through Inherit to the provider, then Global, then the system proxy", () => {
    expect(resolveProxyChain({ account: {}, provider: "sg", global: "eu", pools })).toMatchObject({ layer: "provider", proxyPoolId: "sg", strictProxy: false });
    expect(resolveProxyChain({ account: { proxyPoolId: "__none__" }, provider: null, global: "eu", pools })).toMatchObject({ layer: "global", proxyPoolId: "eu" });
    expect(resolveProxyChain({ account: null, pools })).toMatchObject({ layer: "system", source: "none", connectionProxyEnabled: false, direct: false });
  });

  it("stops at Direct, at any layer", () => {
    expect(resolveProxyChain({ account: { proxyPoolId: PROXY_DIRECT }, provider: "eu", global: "eu", pools })).toMatchObject({ layer: "account", direct: true, connectionProxyEnabled: false });
    expect(resolveProxyChain({ account: {}, provider: PROXY_DIRECT, global: "eu", pools })).toMatchObject({ layer: "provider", direct: true });
  });

  it("blocks instead of skipping to the next layer when the chosen pool is off or gone", () => {
    const off = resolveProxyChain({ account: { proxyPoolId: "off" }, global: "eu", pools });
    expect(off).toMatchObject({ layer: "account", source: "blocked", connectionProxyEnabled: false, strictProxy: true });
    expect(off.blockedReason).toContain("Old office VPN");
    expect(resolveProxyChain({ account: {}, provider: "deleted", global: "eu", pools }).blockedReason).toContain("no longer exists");
  });

  it("keeps a legacy per-account URL ahead of the provider and Global layers", () => {
    const r = resolveProxyChain({ account: { connectionProxyEnabled: true, connectionProxyUrl: "http://old.test:8080" }, provider: "eu", pools });
    expect(r).toMatchObject({ layer: "account", source: "legacy", connectionProxyUrl: "http://old.test:8080" });
  });

  it("maps relay pools to a relay URL", () => {
    expect(resolveProxyChain({ global: "relay", pools })).toMatchObject({ source: "cloudflare", vercelRelayUrl: "https://relay.test", connectionProxyEnabled: false });
  });
});

describe("toProxyOptions", () => {
  it("carries strictness, Direct and the block reason through", () => {
    const blocked = resolveProxyChain({ account: { proxyPoolId: "off" }, pools });
    expect(toProxyOptions(blocked)).toMatchObject({ strictProxy: true, direct: false, blockedReason: blocked.blockedReason });
    expect(toProxyOptions(resolveProxyChain({ account: { proxyPoolId: PROXY_DIRECT }, pools }))).toMatchObject({ direct: true });
    expect(toProxyOptions(null)).toMatchObject({ connectionProxyEnabled: false, strictProxy: false, blockedReason: "" });
  });
});

describe("proxyAwareFetch", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function load() {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, options) => { calls.push({ url, options }); return new Response("ok"); });
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    return { proxyAwareFetch, calls };
  }

  it("sends nothing when the account's proxy is blocked", async () => {
    const { proxyAwareFetch, calls } = await load();
    await expect(proxyAwareFetch("https://api.test/v1", {}, { blockedReason: "Proxy pool \"Old office VPN\" is turned off" }))
      .rejects.toThrow(/Request blocked: Proxy pool "Old office VPN" is turned off/);
    expect(calls).toHaveLength(0);
  });

  it("skips the system proxy when Direct was chosen", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://system.proxy.test:8080");
    const { proxyAwareFetch, calls } = await load();
    await proxyAwareFetch("https://api.test/v1", {}, { direct: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].options.dispatcher).toBeUndefined();
  });
});
