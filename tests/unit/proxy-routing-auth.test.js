import { afterEach, describe, expect, it, vi } from "vitest";

const { dbMocks, resolveConnectionProxyConfig } = vi.hoisted(() => ({
  dbMocks: {
    getProviderConnections: vi.fn(async ({ provider }) => [{ id: `${provider}-a`, provider, isActive: true, providerSpecificData: { proxyPoolId: "off" } }]),
    updateProviderConnection: vi.fn(async () => {}),
    getSettings: vi.fn(async () => ({})),
    getProxyPools: vi.fn(async () => []),
    validateApiKey: vi.fn(),
  },
  resolveConnectionProxyConfig: vi.fn(),
}));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/lib/network/connectionProxy", () => ({ pickProxyPoolId: vi.fn(), resolveConnectionProxyConfig }));
vi.mock("@/shared/constants/providers.js", () => ({ FREE_PROVIDERS: {}, resolveProviderId: (p) => p }));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const { resolveProxyChain } = await import("../../src/lib/network/proxyRouting.ts");
const { getProviderCredentials } = await import("../../src/sse/services/auth.js");

const off = { id: "off", name: "Old office VPN", proxyUrl: "http://office.proxy.test:8888", isActive: false };

describe("getProviderCredentials", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.resetModules();
  });

  it("resolves with the provider and hands the result over in proxyAwareFetch's own field names", async () => {
    resolveConnectionProxyConfig.mockResolvedValue(resolveProxyChain({ account: { proxyPoolId: "off" }, pools: { off } }));
    const creds = await getProviderCredentials("codex");
    expect(resolveConnectionProxyConfig).toHaveBeenCalledWith(expect.objectContaining({ proxyPoolId: "off" }), "codex");
    expect(creds.providerSpecificData).toMatchObject({ blockedReason: expect.stringContaining("Old office VPN"), strictProxy: true, direct: false });

    // Handlers like systemone pass providerSpecificData straight in as the proxy options.
    const calls = [];
    globalThis.fetch = vi.fn(async (...args) => { calls.push(args); return new Response("ok"); });
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    await expect(proxyAwareFetch("https://api.test/v1", {}, creds.providerSpecificData)).rejects.toThrow(/Request blocked/);
    expect(calls).toHaveLength(0);
  });

  it("marks a Direct account so the system proxy is skipped", async () => {
    resolveConnectionProxyConfig.mockResolvedValue(resolveProxyChain({ provider: "__direct__", pools: {} }));
    const creds = await getProviderCredentials("github");
    expect(creds.providerSpecificData).toMatchObject({ direct: true, blockedReason: "", connectionProxyEnabled: false });
  });
});
