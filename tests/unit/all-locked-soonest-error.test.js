import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ rows: new Map() }));
const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(async () => [...store.rows.values()].map(row => ({ ...row }))),
  updateProviderConnection: vi.fn(async (id, update) => {
    const row = { ...store.rows.get(id), ...update };
    store.rows.set(id, row);
    return row;
  }),
  getSettings: vi.fn(async () => ({})),
  getProxyPools: vi.fn(async () => []),
  validateApiKey: vi.fn(),
}));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/lib/network/connectionProxy", () => ({
  pickProxyPoolId: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));
vi.spyOn(console, "error").mockImplementation(() => {});

const { markAccountUnavailable, getProviderCredentials } = await import("../../src/sse/services/auth.js");

const PROVIDER = "openai-compatible-chat-test";
const MODEL = "claude-opus-5-5";
const RATE_LIMIT = '{"type":"error","error":{"type":"rate_limit_error","message":"Snowflake enforces per-account per-model rate limits."}}';
const DEMOTED = `${MODEL} demoted after repeated 403 "Not authorized for this endpoint"`;
const NOW = new Date("2026-11-01T17:49:47.000Z").getTime();
const lockKey = `modelLock_${MODEL}`;

// Prod 17:49Z: the dead key sits ahead of the working one and holds a 120s lock.
const deadKey = () => ({
  id: "dead", provider: PROVIDER, name: "dead", authType: "apikey", priority: 7, isActive: true,
  [lockKey]: new Date(NOW + 120_000).toISOString(), lastError: DEMOTED, errorCode: 403,
});
const liveKey = () => ({ id: "live", provider: PROVIDER, name: "live", authType: "apikey", priority: 8, isActive: true, backoffLevel: 0 });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => vi.useRealTimers());

describe("every key locked, the working one only for a moment", () => {
  it("reports the working key's 429, not the dead key's 403", async () => {
    store.rows = new Map([["dead", deadKey()], ["live", liveKey()]]);
    await markAccountUnavailable("live", 429, RATE_LIMIT, PROVIDER, MODEL);

    const creds = await getProviderCredentials(PROVIDER, new Set(), MODEL);

    expect(creds.allRateLimited).toBe(true);
    expect(Number(creds.lastErrorCode)).toBe(429);
    expect(creds.lastError).toMatch(/rate_limit_error/);
    expect(new Date(creds.retryAfter).getTime() - NOW).toBeLessThanOrEqual(2_000);
  });

  it("does not depend on the order the keys come back in", async () => {
    store.rows = new Map([["live", liveKey()], ["dead", deadKey()]]);
    await markAccountUnavailable("live", 429, RATE_LIMIT, PROVIDER, MODEL);

    const creds = await getProviderCredentials(PROVIDER, new Set(), MODEL);

    expect(Number(creds.lastErrorCode)).toBe(429);
  });

  it("still reports the 403 once the dead key is the one that frees up first", async () => {
    store.rows = new Map([["dead", { ...deadKey(), [lockKey]: new Date(NOW + 1_000).toISOString() }], ["live", liveKey()]]);
    await markAccountUnavailable("live", 429, RATE_LIMIT, PROVIDER, MODEL);

    const creds = await getProviderCredentials(PROVIDER, new Set(), MODEL);

    expect(Number(creds.lastErrorCode)).toBe(403);
    expect(creds.lastError).toBe(DEMOTED);
  });
});
