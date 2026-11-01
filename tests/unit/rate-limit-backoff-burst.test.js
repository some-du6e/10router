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
}));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/lib/network/connectionProxy", () => ({
  pickProxyPoolId: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));
vi.spyOn(console, "error").mockImplementation(() => {});

const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");

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

  it("treats an account-wide lock like a model lock", async () => {
    store.rows.get("key-a").modelLock___all = new Date(NOW + 10_000).toISOString();

    await markAccountUnavailable("key-a", 429, RATE_LIMIT, PROVIDER, MODEL);

    expect(store.rows.get("key-a").backoffLevel).toBe(4);
    expect(lockSeconds()).toBe(16);
  });
});
