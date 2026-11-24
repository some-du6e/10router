// The pool and refresh paths around proxy routing: new pools start strict, a
// pool a layer still uses can't be deleted, and the background refresher skips
// accounts whose proxy is blocked (it tries the others).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  createProxyPool: vi.fn(async (data) => ({ id: "new", ...data })),
  getProviderConnections: vi.fn(async () => []),
  getProxyPools: vi.fn(async () => []),
  getProxyPoolById: vi.fn(async (id) => ({ id, name: id, proxyUrl: "http://p.test:1", isActive: id !== "off" })),
  deleteProxyPool: vi.fn(async () => true),
  updateProxyPool: vi.fn(),
  getSettings: vi.fn(async () => ({})),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/models", () => ({
  createProxyPool: m.createProxyPool, getProviderConnections: m.getProviderConnections, getProxyPools: m.getProxyPools,
  getProxyPoolById: m.getProxyPoolById, deleteProxyPool: m.deleteProxyPool, updateProxyPool: m.updateProxyPool,
}));
vi.mock("@/lib/db/index.js", () => ({ getSettings: m.getSettings, getProxyPoolById: m.getProxyPoolById }));
vi.mock("../../src/sse/utils/logger.js", () => m.log);

const { POST } = await import("../../src/app/api/proxy-pools/route.js");
const { DELETE } = await import("../../src/app/api/proxy-pools/[id]/route.js");
const { runBackgroundTokenRefreshTick } = await import("../../src/sse/services/backgroundTokenRefresh.js");

const json = (body) => new Request("http://localhost/api/proxy-pools", { method: "POST", body: JSON.stringify(body) });
const params = (id) => ({ params: Promise.resolve({ id }) });

beforeEach(() => vi.clearAllMocks());

describe("POST /api/proxy-pools", () => {
  it("makes a new pool strict unless told otherwise", async () => {
    await POST(json({ name: "EU", proxyUrl: "http://eu.test:3128" }));
    expect(m.createProxyPool).toHaveBeenLastCalledWith(expect.objectContaining({ strictProxy: true }));
    await POST(json({ name: "SG", proxyUrl: "http://sg.test:1080", strictProxy: false }));
    expect(m.createProxyPool).toHaveBeenLastCalledWith(expect.objectContaining({ strictProxy: false }));
  });
});

describe("DELETE /api/proxy-pools/[id]", () => {
  it("refuses a pool Global or a provider still uses, and names the layer", async () => {
    m.getSettings.mockResolvedValue({ globalProxyPoolId: " eu ", providerStrategies: { codex: { proxyPoolId: "sg" } } });
    const global = await DELETE(new Request("http://localhost"), params("eu"));
    expect(global.status).toBe(409);
    expect((await global.json()).boundLayers).toEqual(["Global"]);
    const provider = await DELETE(new Request("http://localhost"), params("sg"));
    expect((await provider.json()).boundLayers).toEqual(["codex"]);
    expect(m.deleteProxyPool).not.toHaveBeenCalled();

    expect((await DELETE(new Request("http://localhost"), params("unused"))).status).toBe(200);
    expect(m.deleteProxyPool).toHaveBeenCalledWith("unused");
  });
});

describe("background token refresh", () => {
  const NOW = Date.parse("2026-08-01T12:00:00.000Z");
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => vi.useRealTimers());

  it("skips an account whose proxy is blocked and refreshes the rest", async () => {
    const due = (id, psd) => ({ id, provider: "grok-cli", authType: "oauth", refreshToken: `rt-${id}`, isActive: true, expiresAt: new Date(NOW + 10 * 60 * 1000).toISOString(), providerSpecificData: psd });
    m.getSettings.mockResolvedValue({});
    await runBackgroundTokenRefreshTick({ loadConnections: async () => [due("blocked", { proxyPoolId: "off" }), due("ok", {})] });
    // "blocked" is bound to a pool that's off, so the real resolver blocks it. The
    // refresh itself fails here (no DB) and the tick logs each attempt it made:
    // only the unblocked account got one.
    const attempted = m.log.warn.mock.calls.map(([, , meta]) => meta?.id).filter(Boolean);
    expect(attempted).toEqual(["ok"]);
  });
});
