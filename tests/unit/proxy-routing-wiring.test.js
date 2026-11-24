import { beforeEach, describe, expect, it, vi } from "vitest";

const { settings, pools, getProviderConnectionById } = vi.hoisted(() => ({
  settings: { current: {} },
  pools: { current: {} },
  getProviderConnectionById: vi.fn(),
}));

vi.mock("@/lib/db/index.js", () => ({
  getSettings: vi.fn(async () => settings.current),
  getProxyPoolById: vi.fn(async (id) => pools.current[id] ?? null),
}));
vi.mock("../../src/lib/localDb.js", () => ({ getProviderConnectionById }));
vi.mock("@/lib/localDb", () => ({ getProviderConnectionById }));

import { getSettings } from "@/lib/db/index.js";
import { resolveConnectionProxyConfig } from "../../src/lib/network/connectionProxy.ts";
import { checkAndRefreshToken } from "../../src/sse/services/tokenRefresh.js";

const eu = { id: "eu", name: "Residential EU", proxyUrl: "http://eu.proxy.test:3128", isActive: true, strictProxy: true };
const off = { id: "off", name: "Old office VPN", proxyUrl: "http://office.proxy.test:8888", isActive: false };

beforeEach(() => {
  settings.current = { globalProxyPoolId: "eu", providerStrategies: { codex: { proxyPoolId: "off" }, github: { proxyPoolId: "__direct__" } } };
  pools.current = { eu, off };
});

describe("resolveConnectionProxyConfig", () => {
  it("reads the provider layer from providerStrategies and Global from globalProxyPoolId", async () => {
    expect(await resolveConnectionProxyConfig({}, "claude")).toMatchObject({ layer: "global", connectionProxyUrl: eu.proxyUrl, strictProxy: true });
    expect(await resolveConnectionProxyConfig({}, "github")).toMatchObject({ layer: "provider", direct: true });
    const blocked = await resolveConnectionProxyConfig({}, "codex");
    expect(blocked).toMatchObject({ layer: "provider", source: "blocked" });
    expect(blocked.blockedReason).toContain("Old office VPN");
  });

  it("skips the provider layer when no provider is given", async () => {
    expect(await resolveConnectionProxyConfig({}, undefined)).toMatchObject({ layer: "global", proxyPoolId: "eu" });
  });

  it("fails closed when the settings can't be read", async () => {
    vi.mocked(getSettings).mockRejectedValueOnce(new Error("db locked"));
    const r = await resolveConnectionProxyConfig({ proxyPoolId: "eu" }, "claude");
    expect(r).toMatchObject({ source: "error", strictProxy: true, connectionProxyEnabled: false });
    expect(r.blockedReason).toBeTruthy();
  });
});

describe("checkAndRefreshToken", () => {
  it("doesn't refresh an account whose proxy is blocked", async () => {
    const credentials = { connectionId: "a", refreshToken: "rt", expiresAt: new Date(0).toISOString(), providerSpecificData: { blockedReason: "Proxy pool \"Old office VPN\" is turned off" } };
    expect(await checkAndRefreshToken("codex", credentials)).toBe(credentials);
    expect(getProviderConnectionById).not.toHaveBeenCalled();
  });
});
