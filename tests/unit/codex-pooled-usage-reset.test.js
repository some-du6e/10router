import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ connections: vi.fn(), usage: vi.fn() }));
vi.mock("@/lib/localDb", () => ({ getProviderConnections: mocks.connections }));
vi.mock("open-sse/services/usage/codex.js", () => ({ getCodexUsage: mocks.usage }));
vi.mock("@/sse/services/tokenRefresh", () => ({ refreshCodexToken: vi.fn(), updateProviderCredentials: vi.fn() }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: async () => ({}) }));

const usage = (used) => ({ plan: "plus", quotas: { session: { used, total: 100 } } });
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

describe("pooled Codex usage after reset", () => {
  beforeEach(() => {
    delete globalThis[Symbol.for("10router.codexPooledUsage")];
    vi.resetModules();
    vi.resetAllMocks();
    vi.useFakeTimers();
    mocks.connections.mockResolvedValue([{ id: "conn_1", provider: "codex", accessToken: "token", providerSpecificData: { workspaceId: "acct_123" } }]);
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it("refreshes immediately instead of keeping exhausted headers for the one-minute TTL", async () => {
    mocks.usage.mockResolvedValueOnce(usage(100)).mockResolvedValueOnce(usage(0));
    const pool = await import("@/sse/services/codexPooledUsage.js");
    pool.getPooledCodexRateLimitHeaders();
    await settle();
    expect(pool.getPooledCodexRateLimitHeaders()["x-codex-primary-used-percent"]).toBe("100");
    pool.invalidatePooledCodexUsage();
    expect(pool.getPooledCodexRateLimitHeaders()).toEqual({});
    await settle();
    expect(pool.getPooledCodexRateLimitHeaders()["x-codex-primary-used-percent"]).toBe("0");
    expect(mocks.usage).toHaveBeenCalledWith("token", expect.any(Object), { workspaceId: "acct_123" });
  });

  it("shares reset invalidation across separately loaded route modules", async () => {
    mocks.usage.mockResolvedValueOnce(usage(100)).mockResolvedValueOnce(usage(0));
    const responsesRoute = await import("@/sse/services/codexPooledUsage.js");
    responsesRoute.getPooledCodexRateLimitHeaders();
    await settle();
    vi.resetModules();
    const resetRoute = await import("@/sse/services/codexPooledUsage.js");
    resetRoute.invalidatePooledCodexUsage();
    await settle();
    expect(responsesRoute.getPooledCodexRateLimitHeaders()["x-codex-primary-used-percent"]).toBe("0");
  });

  it("discards an exhausted refresh that started before the reset and finishes after it", async () => {
    let resolveOld;
    mocks.usage.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; })).mockResolvedValueOnce(usage(0));
    const pool = await import("@/sse/services/codexPooledUsage.js");
    pool.getPooledCodexRateLimitHeaders();
    await settle();
    pool.invalidatePooledCodexUsage();
    await settle();
    expect(pool.getPooledCodexRateLimitHeaders()["x-codex-primary-used-percent"]).toBe("0");
    resolveOld(usage(100));
    await settle();
    expect(pool.getPooledCodexRateLimitHeaders()["x-codex-primary-used-percent"]).toBe("0");
  });
});
