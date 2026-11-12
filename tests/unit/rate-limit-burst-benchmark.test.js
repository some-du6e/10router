// Benchmark: one key behind a per-model upstream rate limit at peak load.
// Run: cd tests && ./node_modules/.bin/vitest run --config ./vitest.benchmark.config.js rate-limit-burst
//
// Drives the real getProviderCredentials / markAccountUnavailable / clearAccountError
// on simulated time. Shape is from the 2026-10-31 03Z peak: ~126 requests/min on
// one key, 429s back in ~0.6s, successes in ~2.5s, and Claude Code retrying
// 429/503 with exponential backoff.
import { describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ rows: new Map() }));
vi.mock("@/lib/localDb", () => ({
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
vi.mock("@/lib/network/connectionProxy", () => ({
  pickProxyPoolId: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.spyOn(console, "error").mockImplementation(() => {});

const { getProviderCredentials, markAccountUnavailable, clearAccountError } = await import("../../src/sse/services/auth.js");

const PROVIDER = "openai-compatible-chat-bench";
const MODEL = "claude-opus-5-5";
const RATE_LIMIT = '{"type":"error","error":{"type":"rate_limit_error","message":"per-account per-model rate limits"}}';
const SIM_MS = 15 * 60_000;
const ARRIVALS_PER_MIN = 126;
// Upstream allows ~100 requests/min with a burst of 15.
const BUCKET = { capacity: 15, refillPerMs: 100 / 60_000 };
const ERROR_MS = 600;
const SUCCESS_MS = 2_500;
const CLIENT_RETRIES = 10;
const clientBackoffMs = (attempt) => Math.min(500 * 2 ** attempt, 32_000);

function rng(seed) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

async function simulate() {
  store.rows = new Map([["key-a", { id: "key-a", provider: PROVIDER, name: "key-a", authType: "apikey", apiKey: "bench", isActive: true, backoffLevel: 0 }]]);
  const random = rng(42);
  const stats = { requests: 0, served: 0, gaveUp: 0, localRejects: 0, upstream429: 0, longestLockS: 0 };
  let tokens = BUCKET.capacity;
  let refilledAt = Date.now();
  const start = Date.now();

  const attempt = async (n) => {
    const credentials = await getProviderCredentials(PROVIDER, null, MODEL);
    let ok = false;
    if (credentials?.allRateLimited) {
      stats.localRejects++;
    } else {
      tokens = Math.min(BUCKET.capacity, tokens + (Date.now() - refilledAt) * BUCKET.refillPerMs);
      refilledAt = Date.now();
      ok = tokens >= 1;
      if (ok) tokens--;
      await new Promise(resolve => setTimeout(resolve, ok ? SUCCESS_MS : ERROR_MS));
      if (ok) {
        await clearAccountError(credentials.connectionId, credentials, MODEL);
      } else {
        stats.upstream429++;
        const { cooldownMs } = await markAccountUnavailable(credentials.connectionId, 429, RATE_LIMIT, PROVIDER, MODEL);
        stats.longestLockS = Math.max(stats.longestLockS, Math.round(cooldownMs / 1000));
      }
    }
    if (ok) {
      stats.served++;
    } else if (n >= CLIENT_RETRIES) {
      stats.gaveUp++;
    } else {
      setTimeout(() => attempt(n + 1), clientBackoffMs(n));
    }
  };

  let next = start;
  while (next < start + SIM_MS) {
    next += -Math.log(1 - random()) * (60_000 / ARRIVALS_PER_MIN);
    const at = next;
    setTimeout(() => { stats.requests++; attempt(0); }, at - start);
  }
  // Let the last arrivals run out their retries.
  for (let t = 0; t < SIM_MS + 10 * 60_000; t += 50) await vi.advanceTimersByTimeAsync(50);

  return { ...stats, finalBackoffLevel: store.rows.get("key-a").backoffLevel };
}

describe("rate-limit burst benchmark", () => {
  it("serves peak load through one rate-limited key", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-31T03:15:00.000Z") });
    let result;
    try {
      result = await simulate();
    } finally {
      vi.useRealTimers();
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    expect(result.served + result.gaveUp).toBe(result.requests);
    // Without the burst fix: 16% served and a 300s lock.
    expect(result.served / result.requests).toBeGreaterThan(0.8);
    expect(result.longestLockS).toBeLessThan(32);
  }, 120_000);
});
