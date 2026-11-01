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
const { checkFallbackError, isModelLockActive, getModelLockUntil } = await import("../../open-sse/services/accountFallback.js");

const PROVIDER = "openai-compatible-chat-test";
const MODEL = "claude-opus-5-5";
const RATE_LIMIT = '{"type":"error","error":{"type":"rate_limit_error","message":"Snowflake enforces per-account per-model rate limits."}}';
const NOW = new Date("2026-10-31T03:21:26.000Z").getTime();

const lockSeconds = () => (new Date(store.rows.get("key-a")[`modelLock_${MODEL}`]).getTime() - Date.now()) / 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  store.rows = new Map([["key-a", { id: "key-a", provider: PROVIDER, name: "key-a", authType: "apikey", backoffLevel: 4 }]]);
});

afterEach(() => vi.useRealTimers());

describe("429 backoff under a burst of concurrent requests", () => {
  it("escalates once when several in-flight requests hit the same rate limit", async () => {
    // Four requests were already upstream when the limit hit (prod 03:21:26Z: 32s → 64s → 128s → 256s).
    for (let i = 0; i < 4; i++) {
      await markAccountUnavailable("key-a", 429, RATE_LIMIT, PROVIDER, MODEL);
      vi.advanceTimersByTime(70);
    }

    expect(store.rows.get("key-a").backoffLevel).toBe(5);
    // The lock runs at the current level from the last 429 (70ms ago).
    expect(lockSeconds()).toBeCloseTo(32 - 0.07, 2);
  });

  it("escalates when the limit hits again after the lock expired", async () => {
    await markAccountUnavailable("key-a", 429, RATE_LIMIT, PROVIDER, MODEL);
    vi.advanceTimersByTime(33_000);
    await markAccountUnavailable("key-a", 429, RATE_LIMIT, PROVIDER, MODEL);

    expect(store.rows.get("key-a").backoffLevel).toBe(6);
    expect(lockSeconds()).toBe(64);
  });

  it("keeps a straggler from shortening a longer lock already in place", async () => {
    store.rows.get("key-a")[`modelLock_${MODEL}`] = new Date(NOW + 120_000).toISOString();

    await markAccountUnavailable("key-a", 429, RATE_LIMIT, PROVIDER, MODEL);

    expect(store.rows.get("key-a").backoffLevel).toBe(4);
    expect(lockSeconds()).toBe(120);
  });

  it("re-arms the current level when a straggler lands near the end of a lock", async () => {
    store.rows.get("key-a")[`modelLock_${MODEL}`] = new Date(NOW + 1_000).toISOString();

    await markAccountUnavailable("key-a", 429, RATE_LIMIT, PROVIDER, MODEL);

    expect(store.rows.get("key-a").backoffLevel).toBe(4);
    expect(lockSeconds()).toBe(16);
  });

  it("keeps a longer account-wide lock in force without copying it onto the model", async () => {
    store.rows.get("key-a").modelLock___all = new Date(NOW + 120_000).toISOString();

    await markAccountUnavailable("key-a", 429, RATE_LIMIT, PROVIDER, MODEL);

    const row = store.rows.get("key-a");
    expect(row.backoffLevel).toBe(4);
    expect(lockSeconds()).toBe(16);
    vi.advanceTimersByTime(30_000);
    expect(isModelLockActive(row, MODEL)).toBe(true);
    expect(getModelLockUntil(row, MODEL)).toBe(NOW + 120_000);
  });

  it("sees an account-wide lock behind an expired model lock", async () => {
    const row = store.rows.get("key-a");
    row[`modelLock_${MODEL}`] = new Date(NOW - 5_000).toISOString();
    row.modelLock___all = new Date(NOW + 60_000).toISOString();
    expect(isModelLockActive(row, MODEL)).toBe(true);

    await markAccountUnavailable("key-a", 429, RATE_LIMIT, PROVIDER, MODEL);

    expect(store.rows.get("key-a").backoffLevel).toBe(4);
  });

  it("keeps a longer lock at the top backoff level", async () => {
    const row = store.rows.get("key-a");
    row.backoffLevel = 15;
    row[`modelLock_${MODEL}`] = new Date(NOW + 25 * 60_000).toISOString();

    await markAccountUnavailable("key-a", 429, RATE_LIMIT, PROVIDER, MODEL);

    expect(store.rows.get("key-a").backoffLevel).toBe(15);
    expect(lockSeconds()).toBe(25 * 60);
  });

  it("keeps the provider reset time of the lock a straggler lands in", async () => {
    const resetAt = new Date(NOW + 600_000).toISOString();
    const row = store.rows.get("key-a");
    row[`modelLock_${MODEL}`] = resetAt;
    row[`providerReset_${MODEL}`] = resetAt;
    row[`modelLimit_${MODEL}`] = true;

    await markAccountUnavailable("key-a", 429, RATE_LIMIT, PROVIDER, MODEL);

    const after = store.rows.get("key-a");
    expect(after[`providerReset_${MODEL}`]).toBe(resetAt);
    expect(after[`modelLimit_${MODEL}`]).toBe(true);
    expect(lockSeconds()).toBe(600);
  });

  it("applies to any backoff error, like a 503 overloaded, not just 429", async () => {
    store.rows.get("key-a")[`modelLock_${MODEL}`] = new Date(NOW + 1_000).toISOString();

    await markAccountUnavailable("key-a", 503, "upstream overloaded", PROVIDER, MODEL);

    expect(store.rows.get("key-a").backoffLevel).toBe(4);
    expect(lockSeconds()).toBe(16);
  });

  it("leaves errors without backoff on their own cooldown during a lock", async () => {
    const BAD_KEY = "invalid api key";
    store.rows.get("key-a")[`modelLock_${MODEL}`] = new Date(NOW + 1_000).toISOString();
    const { cooldownMs, newBackoffLevel } = checkFallbackError(401, BAD_KEY, 4);
    expect(newBackoffLevel).toBeUndefined();

    await markAccountUnavailable("key-a", 401, BAD_KEY, PROVIDER, MODEL);

    expect(store.rows.get("key-a").backoffLevel).toBe(4);
    expect(lockSeconds()).toBe(cooldownMs / 1000);
  });

  it("marks the lock a limit when a 429 straggler lands in a lock from an overload", async () => {
    const row = store.rows.get("key-a");
    row[`modelLock_${MODEL}`] = new Date(NOW + 30_000).toISOString();
    row[`modelLimit_${MODEL}`] = false;

    await markAccountUnavailable("key-a", 429, RATE_LIMIT, PROVIDER, MODEL);

    expect(store.rows.get("key-a")[`modelLimit_${MODEL}`]).toBe(true);
  });

  it("keeps a limit lock marked when an overload straggler lands in it", async () => {
    const row = store.rows.get("key-a");
    row[`modelLock_${MODEL}`] = new Date(NOW + 30_000).toISOString();
    row[`modelLimit_${MODEL}`] = true;

    await markAccountUnavailable("key-a", 503, "upstream overloaded", PROVIDER, MODEL);

    expect(store.rows.get("key-a")[`modelLimit_${MODEL}`]).toBe(true);
  });

  it("doesn't inherit the limit flag or reset of an expired model lock under an account-wide lock", async () => {
    const row = store.rows.get("key-a");
    Object.assign(row, {
      [`modelLock_${MODEL}`]: new Date(NOW - 60_000).toISOString(),
      [`modelLimit_${MODEL}`]: true,
      [`providerReset_${MODEL}`]: new Date(NOW - 60_000).toISOString(),
      modelLock___all: new Date(NOW + 60_000).toISOString(),
      modelLimit___all: false,
    });

    await markAccountUnavailable("key-a", 503, "upstream overloaded", PROVIDER, MODEL);

    const after = store.rows.get("key-a");
    expect(after.backoffLevel).toBe(4);
    expect(after[`modelLimit_${MODEL}`]).toBe(false);
    expect(after[`providerReset_${MODEL}`]).toBeNull();
  });

  it("treats an account-wide lock like a model lock", async () => {
    store.rows.get("key-a").modelLock___all = new Date(NOW + 10_000).toISOString();

    await markAccountUnavailable("key-a", 429, RATE_LIMIT, PROVIDER, MODEL);

    expect(store.rows.get("key-a").backoffLevel).toBe(4);
    expect(lockSeconds()).toBe(16);
  });
});

describe("all accounts hit their limits", () => {
  const exhausted = async () => (await getProviderCredentials(PROVIDER, null, MODEL))?.allLimitsExhausted;

  beforeEach(() => Object.assign(store.rows.get("key-a"), { isActive: true, apiKey: "test" }));

  it("ignores the limit flag of an expired model lock under an account-wide lock", async () => {
    Object.assign(store.rows.get("key-a"), {
      [`modelLock_${MODEL}`]: new Date(NOW - 5_000).toISOString(), [`modelLimit_${MODEL}`]: true,
      modelLock___all: new Date(NOW + 60_000).toISOString(), modelLimit___all: false,
    });
    expect(await exhausted()).toBe(false);
  });

  it("counts an account-wide limit lock behind an expired model lock", async () => {
    Object.assign(store.rows.get("key-a"), {
      [`modelLock_${MODEL}`]: new Date(NOW - 5_000).toISOString(), [`modelLimit_${MODEL}`]: false,
      modelLock___all: new Date(NOW + 60_000).toISOString(), modelLimit___all: true,
    });
    expect(await exhausted()).toBe(true);
  });
});
