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
// Quota blocks per key id, for the soonest-reset strategy.
const blocked = vi.hoisted(() => new Map());
vi.mock("../../src/sse/services/soonestReset.js", () => ({
  getRoutingQuotas: (_provider, connections) => new Map(connections.map(c => [c.id, c.id])),
  getResetState: (_provider, id) => ({ blockedUntil: blocked.get(id) || 0 }),
  pickSoonestReset: connections => connections[0],
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));
vi.spyOn(console, "error").mockImplementation(() => {});

const { markAccountUnavailable, getProviderCredentials } = await import("../../src/sse/services/auth.js");
const { allLockedError } = await import("../../open-sse/utils/limitHold.js");

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
  dbMocks.getSettings.mockImplementation(async () => ({}));
  blocked.clear();
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

  it("reports the rate-limited key even when the dead key frees up first", async () => {
    // The live key's backoff has climbed past the dead key's 120s lock.
    store.rows = new Map([["dead", deadKey()], ["live", { ...liveKey(), backoffLevel: 7 }]]);
    await markAccountUnavailable("live", 429, RATE_LIMIT, PROVIDER, MODEL);

    const creds = await getProviderCredentials(PROVIDER, new Set(), MODEL);

    expect(Number(creds.lastErrorCode)).toBe(429);
    expect(creds.lastError).toMatch(/rate_limit_error/);
    expect(new Date(creds.retryAfter).getTime() - NOW).toBe(120_000);
  });

  it("still reports the 403 when every key is dead", async () => {
    store.rows = new Map([["dead", deadKey()], ["dead2", { ...deadKey(), id: "dead2", name: "dead2", [lockKey]: new Date(NOW + 60_000).toISOString() }]]);

    const creds = await getProviderCredentials(PROVIDER, new Set(), MODEL);

    expect(Number(creds.lastErrorCode)).toBe(403);
    expect(creds.lastError).toBe(DEMOTED);
  });

  it("reports a 429 when the limited key's last error was a 403 on another model", async () => {
    store.rows = new Map([["dead", deadKey()], ["live", liveKey()]]);
    await markAccountUnavailable("live", 429, RATE_LIMIT, PROVIDER, MODEL);
    store.rows.set("live", { ...store.rows.get("live"), errorCode: 403, lastError: "Not authorized for this endpoint" });

    const creds = await getProviderCredentials(PROVIDER, new Set(), MODEL);

    expect(Number(creds.lastErrorCode)).toBe(429);
    expect(creds.lastError).toBe(`Rate limited on ${MODEL}`);
  });

  it("still reports the 403 when every key is dead and its 403 had no body", async () => {
    // A bodyless 403 gets "You exceeded your current quota", which flags the lock as a limit.
    store.rows = new Map([["a", { ...liveKey(), id: "a", name: "a" }], ["b", { ...liveKey(), id: "b", name: "b" }]]);
    await markAccountUnavailable("a", 403, "You exceeded your current quota", PROVIDER, MODEL);
    await markAccountUnavailable("b", 403, "You exceeded your current quota", PROVIDER, MODEL);

    const creds = await getProviderCredentials(PROVIDER, new Set(), MODEL);

    expect(Number(creds.lastErrorCode)).toBe(403);
    expect(allLockedError(403, "You exceeded your current quota", creds).status).toBe(403);
  });

  it("reports the rate-limited key over a bodyless-403 dead key that frees up first", async () => {
    store.rows = new Map([["dead", { ...liveKey(), id: "dead", name: "dead" }], ["live", { ...liveKey(), backoffLevel: 7 }]]);
    await markAccountUnavailable("dead", 403, "You exceeded your current quota", PROVIDER, MODEL);
    await markAccountUnavailable("live", 429, RATE_LIMIT, PROVIDER, MODEL);

    const creds = await getProviderCredentials(PROVIDER, new Set(), MODEL);

    expect(Number(creds.lastErrorCode)).toBe(429);
  });

  it("does not report a 5xx from another model for a key refused on this one", async () => {
    store.rows = new Map([["dead", deadKey()], ["refused", { ...liveKey(), id: "refused", name: "refused" }]]);
    await markAccountUnavailable("refused", 403, "Not authorized for this endpoint", PROVIDER, MODEL);
    store.rows.set("refused", { ...store.rows.get("refused"), [lockKey]: new Date(NOW + 10_000).toISOString(), errorCode: 503, lastError: "overloaded on other-model" });

    const creds = await getProviderCredentials(PROVIDER, new Set(), MODEL);

    expect(allLockedError(403, "Not authorized for this endpoint", creds).status).toBe(403);
  });

  it("reports a 429 for a rate-limited key whose stored error was cleared", async () => {
    store.rows = new Map([["dead", deadKey()], ["live", liveKey()]]);
    await markAccountUnavailable("live", 429, RATE_LIMIT, PROVIDER, MODEL);
    store.rows.set("live", { ...store.rows.get("live"), errorCode: null, lastError: null });

    const creds = await getProviderCredentials(PROVIDER, new Set(), MODEL);

    expect(allLockedError(403, "Not authorized for this endpoint", creds).status).toBe(429);
  });

  it("reports a 429 when the limited key's last error was a 400 on another model", async () => {
    store.rows = new Map([["dead", deadKey()], ["live", liveKey()]]);
    await markAccountUnavailable("live", 429, RATE_LIMIT, PROVIDER, MODEL);
    store.rows.set("live", { ...store.rows.get("live"), errorCode: 400, lastError: "unsupported parameter on other-model" });

    const creds = await getProviderCredentials(PROVIDER, new Set(), MODEL);

    expect(Number(creds.lastErrorCode)).toBe(429);
    expect(allLockedError(403, "Not authorized for this endpoint", creds).status).toBe(429);
  });

  it("under soonest-reset, reports the dead key's 403 over a quota-only key that frees up first", async () => {
    dbMocks.getSettings.mockImplementation(async () => ({ fallbackStrategy: "soonest-reset" }));
    store.rows = new Map([["quota", { ...liveKey(), id: "quota", name: "quota" }], ["dead", deadKey()]]);
    blocked.set("quota", NOW + 10_000);

    const creds = await getProviderCredentials(PROVIDER, new Set(), MODEL);

    expect(Number(creds.lastErrorCode)).toBe(403);
    expect(new Date(creds.retryAfter).getTime() - NOW).toBe(10_000);
  });

  it("keeps a limited key's stored 5xx and its message", async () => {
    store.rows = new Map([["dead", deadKey()], ["live", liveKey()]]);
    await markAccountUnavailable("live", 429, RATE_LIMIT, PROVIDER, MODEL);
    store.rows.set("live", { ...store.rows.get("live"), errorCode: 503, lastError: "overloaded" });

    const creds = await getProviderCredentials(PROVIDER, new Set(), MODEL);

    expect(Number(creds.lastErrorCode)).toBe(503);
    expect(creds.lastError).toBe("overloaded");
  });

  it("lets a longer account-wide refusal outrank a short limit lock on the model", async () => {
    store.rows = new Map([["a", { ...liveKey(), id: "a", name: "a" }]]);
    await markAccountUnavailable("a", 429, RATE_LIMIT, PROVIDER, MODEL);
    await markAccountUnavailable("a", 401, "Invalid API key provided", PROVIDER, null);

    const creds = await getProviderCredentials(PROVIDER, new Set(), MODEL);

    expect(Number(creds.lastErrorCode)).toBe(401);
  });

  it("prefers the dead key's 403 over another model's 429 when no key was tried yet", async () => {
    store.rows = new Map([["dead", deadKey()], ["refused", { ...liveKey(), id: "refused", name: "refused" }]]);
    await markAccountUnavailable("refused", 403, "Not authorized for this endpoint", PROVIDER, MODEL);
    store.rows.set("refused", { ...store.rows.get("refused"), [lockKey]: new Date(NOW + 60_000).toISOString(), errorCode: 429, lastError: "rate limited on other" });

    const creds = await getProviderCredentials(PROVIDER, new Set(), MODEL);

    expect(allLockedError(null, null, creds).status).toBe(403);
  });

  it("keeps a 402 plan limit's own code and message", async () => {
    const PLAN = "You've reached your additional usage limit for your plan.";
    store.rows = new Map([["a", { ...liveKey(), id: "a", name: "a" }]]);
    await markAccountUnavailable("a", 402, PLAN, PROVIDER, MODEL);

    const creds = await getProviderCredentials(PROVIDER, new Set(), MODEL);

    expect(Number(creds.lastErrorCode)).toBe(402);
    expect(creds.lastError).toBe(PLAN);
  });

  it("does not report a 429 from another model for a key refused on this one", async () => {
    store.rows = new Map([["dead", deadKey()], ["refused", { ...liveKey(), id: "refused", name: "refused" }]]);
    await markAccountUnavailable("refused", 403, "Not authorized for this endpoint", PROVIDER, MODEL);
    // It frees up before the dead key, so it is the one reported.
    store.rows.set("refused", { ...store.rows.get("refused"), [lockKey]: new Date(NOW + 10_000).toISOString(), errorCode: 429, lastError: "rate_limit_error on other-model" });

    const creds = await getProviderCredentials(PROVIDER, new Set(), MODEL);

    expect(allLockedError(403, "Not authorized for this endpoint", creds).status).toBe(403);
  });

  it("counts the dead key's account-wide lock, not just its lock on the model", async () => {
    store.rows = new Map([
      ["dead", { ...deadKey(), [lockKey]: new Date(NOW + 1_000).toISOString(), modelLock___all: new Date(NOW + 120_000).toISOString() }],
      ["live", liveKey()],
    ]);
    await markAccountUnavailable("live", 429, RATE_LIMIT, PROVIDER, MODEL);

    const creds = await getProviderCredentials(PROVIDER, new Set(), MODEL);

    expect(Number(creds.lastErrorCode)).toBe(429);
    expect(new Date(creds.retryAfter).getTime() - NOW).toBe(2_000);
  });

  it("takes the retry time from the model's own locks, not a lock on another model", async () => {
    store.rows = new Map([["dead", { ...deadKey(), "modelLock_other-model": new Date(NOW + 500).toISOString() }], ["live", liveKey()]]);
    await markAccountUnavailable("live", 429, RATE_LIMIT, PROVIDER, MODEL);

    const creds = await getProviderCredentials(PROVIDER, new Set(), MODEL);

    expect(new Date(creds.retryAfter).getTime() - NOW).toBe(2_000);
    expect(Number(creds.lastErrorCode)).toBe(429);
  });

  it("reports the working key's 429 under the soonest-reset strategy too", async () => {
    dbMocks.getSettings.mockImplementation(async () => ({ fallbackStrategy: "soonest-reset" }));
    store.rows = new Map([["dead", deadKey()], ["live", liveKey()]]);
    await markAccountUnavailable("live", 429, RATE_LIMIT, PROVIDER, MODEL);

    const creds = await getProviderCredentials(PROVIDER, new Set(), MODEL);

    expect(Number(creds.lastErrorCode)).toBe(429);
    expect(new Date(creds.retryAfter).getTime() - NOW).toBe(2_000);
  });

  it("under soonest-reset, reports a locked key's error over a key blocked only on quota", async () => {
    dbMocks.getSettings.mockImplementation(async () => ({ fallbackStrategy: "soonest-reset" }));
    store.rows = new Map([
      ["quota", { ...liveKey(), id: "quota", name: "quota" }],
      ["limited", { ...liveKey(), id: "limited", name: "limited", [lockKey]: new Date(NOW + 3_600_000).toISOString(), [`modelLimit_${MODEL}`]: true, errorCode: 429, lastError: "rate_limit_error" }],
    ]);
    blocked.set("quota", NOW + 600_000);

    const creds = await getProviderCredentials(PROVIDER, new Set(), MODEL);

    expect(creds.allRateLimited).toBe(true);
    expect(new Date(creds.retryAfter).getTime() - NOW).toBe(600_000);
    expect(Number(creds.lastErrorCode)).toBe(429);
    expect(creds.lastError).toBe("rate_limit_error");
  });
});

describe("status sent when every key is locked", () => {
  const live = { lastErrorCode: 429, lastError: "rate_limit_error" };

  it("prefers the soonest key's retryable code and error over a 401/403 hit earlier in the pass", () => {
    expect(allLockedError(403, "demoted", live)).toEqual({ status: 429, error: "rate_limit_error", swapped: true });
    expect(allLockedError(401, "bad key", live).status).toBe(429);
    expect(allLockedError(403, "demoted", { lastErrorCode: 503, lastError: "overloaded" }).status).toBe(503);
  });

  it("falls back to a 429/5xx another key hit in the same pass", () => {
    const failures = [{ status: 429, error: "rate_limit_error" }, { status: 403, error: "Not authorized" }];
    expect(allLockedError(403, "Not authorized", { lastErrorCode: 403 }, failures)).toEqual({ status: 429, error: "rate_limit_error", swapped: true });
    expect(allLockedError(403, "Not authorized", null, failures).status).toBe(429);
    expect(allLockedError(403, "Not authorized", null, [{ status: 502, error: "Bad gateway" }]).status).toBe(502);
    // A bodyless 403 gets "You exceeded your current quota" as its text.
    expect(allLockedError(403, "Not authorized", null, [{ status: 403, error: "You exceeded your current quota" }])).toEqual({ status: 403, error: "Not authorized", swapped: false });
  });

  it("keeps the old order otherwise", () => {
    expect(allLockedError(403, "demoted", { lastErrorCode: 403, lastError: "demoted" })).toEqual({ status: 403, error: "demoted", swapped: false });
    expect(allLockedError(429, "limit", { lastErrorCode: 403 }).status).toBe(429);
    expect(allLockedError(400, "bad", live).status).toBe(400);
    expect(allLockedError(null, null, { lastErrorCode: 403, lastError: "demoted" })).toEqual({ status: 403, error: "demoted", swapped: false });
    expect(allLockedError(null, null, { lastErrorCode: null })).toEqual({ status: 503, error: null, swapped: false });
    expect(allLockedError(null, null, null).status).toBe(503);
  });
});
