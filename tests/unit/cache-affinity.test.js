// Prompt-cache affinity: a conversation prefers the keys (accounts) warm with
// its upstream prompt cache, and waits out a short rate-limit lock on them
// instead of rebuilding the cache on a cold key.
//
// The routing tests run the real account loop (handleChat → auth.js against a
// temporary database); only the upstream call (handleChatCore) is stubbed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-cache-affinity-"));
const originalDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = tempDir;
delete global._dbAdapter;

const upstream = vi.hoisted(() => ({ calls: [], script: [] }));
const hooks = vi.hoisted(() => ({ onSleep: null, logged: [] }));
vi.mock("open-sse/handlers/chatCore.js", async (importOriginal) => ({
  ...(await importOriginal()),
  handleChatCore: async (args) => {
    upstream.calls.push(args.connectionId);
    const next = upstream.script.shift();
    return next ? next() : { success: true, response: new Response("{}", { status: 200 }) };
  },
}));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: async (m) => (m.includes("/") ? { provider: m.split("/")[0], model: m.split("/")[1] } : { provider: null, model: m }),
  getComboModels: async () => null,
  comboLookupName: (name) => name,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_p, c) => c,
  updateProviderCredentials: async () => {},
}));
// Records what was logged, so a test can tell a cache wait from the limit hold.
vi.mock("@/sse/utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal();
  const record = (level) => (tag, message) => { hooks.logged.push(`${level} ${tag} ${message}`); };
  return { ...actual, debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") };
});
// Seeded quota resets by connection id for soonest-reset; unseeded, the real
// module runs (no quota data: every reset unknown).
const resets = vi.hoisted(() => new Map());
vi.mock("@/sse/services/soonestReset.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getRoutingQuotas: (p, connections) => (resets.size ? new Map(connections.map((c) => [c.id, c.id])) : actual.getRoutingQuotas(p, connections)),
    getResetState: (p, quotas, model, now) => (resets.size
      ? { blockedUntil: 0, weeklyReset: Infinity, sessionReset: Infinity, ...resets.get(quotas) }
      : actual.getResetState(p, quotas, model, now)),
  };
});
// Lets a test act once a wait has started.
vi.mock("open-sse/utils/abortableSleep.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    abortableSleep: (ms, signal) => {
      const slept = actual.abortableSleep(ms, signal);
      hooks.onSleep?.(ms);
      return slept;
    },
  };
});

const db = await import("@/lib/db/index.js");
const { handleChat } = await import("@/sse/handlers/chat.js");
const { markAccountUnavailable, getProviderCredentials } = await import("@/sse/services/auth.js");
const { CACHE_AFFINITY } = await import("open-sse/config/runtimeConfig.js");
const { DEFAULT_TIMING } = await import("open-sse/utils/limitHold.js");
const { resolveClientSessionId } = await import("open-sse/utils/sessionManager.js");
const { getAntigravityQuotaCache } = await import("@/sse/services/antigravityQuota.js");
const affinity = await import("open-sse/services/cacheAffinity.js");

const MODEL = "claude-test";
const SESSION = "0b3c5d7e-1111-4222-8333-944455556666";
const OTHER_SESSION = "aaaaaaaa-0000-4000-8000-000000000000";
const DEFAULTS = { ...CACHE_AFFINITY };
const TIMING = { ...DEFAULT_TIMING };
const BIG_PROMPT = "You are a coding agent. ".repeat(400); // ~2.4k tokens

let providerSeq = 0;
let provider;

beforeAll(async () => {
  await db.updateSettings({ requireApiKey: false, limitHoldEnabled: false });
});

afterAll(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

beforeEach(() => {
  // A fresh provider per test, so no lock or backoff leaks between tests.
  provider = `openai-compatible-cache-test-${++providerSeq}`;
  upstream.calls = [];
  upstream.script = [];
  hooks.onSleep = null;
  hooks.logged = [];
  resets.clear();
  affinity.clearCacheAffinity();
  Object.assign(CACHE_AFFINITY, { maxWaitMs: 1000, minPromptTokens: 1000 });
});

afterEach(async () => {
  vi.useRealTimers();
  Object.assign(CACHE_AFFINITY, DEFAULTS);
  Object.assign(DEFAULT_TIMING, TIMING);
});

async function addKeys(...names) {
  const ids = {};
  for (const [i, name] of names.entries()) {
    const conn = await db.createProviderConnection({
      provider, authType: "apikey", name, apiKey: `placeholder-${name}`, priority: i + 1, isActive: true,
    });
    ids[name] = conn.id;
  }
  return ids;
}

function body({ prompt = BIG_PROMPT, cache = true, session = SESSION } = {}) {
  const system = cache ? [{ type: "text", text: prompt, cache_control: { type: "ephemeral" } }] : prompt;
  return {
    model: `${provider}/${MODEL}`,
    stream: false,
    messages: [{ role: "system", content: system }, { role: "user", content: "fix the bug" }],
    ...(session ? { metadata: { user_id: `user_abc_account__session_${session}` } } : {}),
  };
}

function chat(payload, { signal } = {}) {
  return handleChat(new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  }));
}

const limited = (ms) => () => ({
  success: false,
  status: 429,
  error: "rate_limit_error: too many requests",
  resetsAtMs: Date.now() + ms,
  response: new Response('{"error":{"message":"rate limited"}}', { status: 429 }),
});

// Another request's 429 locks the key on this model for `ms`.
const lockForLimit = (id, ms) => markAccountUnavailable(id, 429, "rate_limit_error", provider, MODEL, Date.now() + ms);
const unlock = (id) => db.updateProviderConnection(id, { [`modelLock_${MODEL}`]: null });
const withStrategy = (fallbackStrategy) => async (fn) => {
  await db.updateSettings({ providerStrategies: { [provider]: { fallbackStrategy } } });
  try {
    await fn();
  } finally {
    await db.updateSettings({ providerStrategies: {} });
  }
};
const withRoundRobin = withStrategy("round-robin");
const withSoonestReset = withStrategy("soonest-reset");
const DAY = 24 * 60 * 60 * 1000;
const cacheWaits = () => hooks.logged.filter((line) => line.startsWith("info CACHE waiting"));

describe("cache affinity routing", () => {
  it("goes back to the first key by priority once usable, even when it isn't warm", async () => {
    const { a, b } = await addKeys("a", "b");
    await lockForLimit(a, 60_000);
    await chat(body());
    await unlock(a);
    expect((await chat(body())).status).toBe(200);
    expect(upstream.calls).toEqual([b, a]);
  });

  it("goes back to the first key by priority once it is usable and still warm", async () => {
    const { a, b } = await addKeys("a", "b");
    await chat(body());
    await lockForLimit(a, 60_000);
    await chat(body());
    await unlock(a);
    await chat(body());
    expect(upstream.calls).toEqual([a, b, a]);
  });

  it("waits out a short limit lock on the warm key instead of moving", async () => {
    const { a } = await addKeys("a", "b");
    await chat(body());
    await lockForLimit(a, 300);

    expect((await chat(body())).status).toBe(200);
    expect(upstream.calls).toEqual([a, a]);
    expect(cacheWaits()).toHaveLength(1);
  });

  it("does not wait on a lock that the slack after it would take past the cap", async () => {
    Object.assign(CACHE_AFFINITY, { lockSlackMs: 600 });
    const { a, b } = await addKeys("a", "b");
    await chat(body());
    await lockForLimit(a, 600);

    expect((await chat(body())).status).toBe(200);
    expect(cacheWaits()).toHaveLength(0);
    expect(upstream.calls).toEqual([a, b]);
  });

  it("keeps round-robin rotating new conversations while one stays on its warm key", async () => {
    await withRoundRobin(async () => {
      const keys = Object.values(await addKeys("a", "b", "c"));
      await chat(body());
      const busy = upstream.calls[0];
      const fresh = [];
      for (let i = 0; i < 6; i++) {
        upstream.calls = [];
        await chat(body({ session: `aaaaaaaa-0000-4000-8000-00000000000${i}` }));
        fresh.push(upstream.calls[0]);
        await chat(body());
        expect(upstream.calls[1]).toBe(busy);
      }
      // Sticky round-robin (3 in a row) over the new conversations alone.
      expect(fresh.filter((id) => id === busy).length).toBeLessThanOrEqual(2);
      expect(new Set(fresh)).toEqual(new Set(keys));
    });
  });

  // Count 1: round-robin would stay on the warm key; count 3: it would restart
  // the warm key's run. Either write would make it the rotation's current key.
  it.each([1, 3])("leaves round-robin's rotation alone on a warm pick (warm key's run at %i)", async (count) => {
    await withRoundRobin(async () => {
      const { a, b } = await addKeys("a", "b", "c");
      await chat(body());
      const now = Date.now();
      await db.updateProviderConnection(a, { lastUsedAt: new Date(now - 60_000).toISOString(), consecutiveUseCount: count });
      await db.updateProviderConnection(b, { lastUsedAt: new Date(now - 1_000).toISOString(), consecutiveUseCount: 1 });
      await chat(body());
      await chat(body({ session: OTHER_SESSION }));
      expect(upstream.calls).toEqual([a, a, b]);
    });
  });

  it("keeps a round-robin conversation on its most recently used warm key", async () => {
    await withRoundRobin(async () => {
      const { a, b } = await addKeys("a", "b", "c");
      await chat(body());
      await lockForLimit(a, 60_000);
      await chat(body());
      await unlock(a);
      // Other traffic has made a the rotation's current key.
      await db.updateProviderConnection(a, { lastUsedAt: new Date().toISOString(), consecutiveUseCount: 1 });
      await chat(body());
      expect(upstream.calls).toEqual([a, b, b]);
    });
  });

  it("retries the warm key after its own short 429", async () => {
    const { a } = await addKeys("a", "b");
    await chat(body());

    upstream.script = [limited(300)];
    expect((await chat(body())).status).toBe(200);
    expect(upstream.calls).toEqual([a, a, a]);
  });

  it("counts the retried warm key once among the request's failures", async () => {
    const { a, b } = await addKeys("a", "b");
    await chat(body());

    upstream.script = [limited(300), limited(60_000), limited(60_000)];
    const res = await chat(body());
    expect(upstream.calls).toEqual([a, a, a, b]);
    expect(res.status).toBe(429);
    const { message } = (await res.json()).error;
    expect(message).toContain("All 2 accounts unavailable");
    expect(message.match(/\ba \(HTTP 429\)/g)).toHaveLength(1);
    expect(message.match(/\bb \(HTTP 429\)/g)).toHaveLength(1);
  });

  it("moves to the next key when the lock outlasts the wait cap", async () => {
    const { a, b } = await addKeys("a", "b");
    await chat(body());

    upstream.script = [limited(5_000)];
    expect((await chat(body())).status).toBe(200);
    expect(upstream.calls).toEqual([a, a, b]);
    expect(cacheWaits()).toHaveLength(0);
  });

  it("stops waiting once the request has waited the cap in all", async () => {
    const { a, b } = await addKeys("a", "b");
    await chat(body());

    // 600ms + 600ms > the 1s cap: the second lock is not waited out.
    upstream.script = [limited(600), limited(600)];
    expect((await chat(body())).status).toBe(200);
    expect(upstream.calls).toEqual([a, a, a, b]);
  });

  it("moves to the next key for a request too small for a rebuild to matter", async () => {
    const { a, b } = await addKeys("a", "b");
    const small = body({ prompt: "Be brief." });
    await chat(small);

    upstream.script = [limited(300)];
    expect((await chat(small)).status).toBe(200);
    expect(upstream.calls).toEqual([a, a, b]);
  });

  it("does not wait on a lock that is not a rate limit", async () => {
    const { a, b } = await addKeys("a", "b");
    await chat(body());
    await markAccountUnavailable(a, 503, "upstream unavailable", provider, MODEL, Date.now() + 300);

    expect((await chat(body())).status).toBe(200);
    expect(upstream.calls).toEqual([a, b]);
  });

  it("stops waiting when the client hangs up", async () => {
    Object.assign(CACHE_AFFINITY, { maxWaitMs: 10_000 });
    const { a } = await addKeys("a", "b");
    await chat(body());
    await lockForLimit(a, 5_000);

    const controller = new AbortController();
    hooks.onSleep = () => controller.abort();
    const started = Date.now();
    const res = await chat(body(), { signal: controller.signal });
    expect(cacheWaits()).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(res.ok).toBe(false);
    expect(upstream.calls).toEqual([a]);
  });

  it("changes nothing with a single key", async () => {
    const { a } = await addKeys("a");
    await chat(body());
    await lockForLimit(a, 300);

    const res = await chat(body());
    expect(res.status).toBe(429);
    expect(cacheWaits()).toHaveLength(0);
    expect(upstream.calls).toEqual([a]);
  });

  it("does not wait when the other key is locked too", async () => {
    const { a, b } = await addKeys("a", "b");
    await chat(body());
    await lockForLimit(a, 300);
    await lockForLimit(b, 60_000);

    const res = await chat(body());
    expect(res.status).toBe(429);
    expect(cacheWaits()).toHaveLength(0);
    expect(upstream.calls).toEqual([a]);
  });

  it("leaves the rate-limit hold to wait when the other key is locked too", async () => {
    Object.assign(DEFAULT_TIMING, { minWaitMs: 10, recheckMs: 10 });
    await db.updateSettings({ limitHoldEnabled: true });
    try {
      const { a, b } = await addKeys("a", "b");
      await chat(body());
      await lockForLimit(a, 300);
      await lockForLimit(b, 60_000);

      expect((await chat(body())).status).toBe(200);
      expect(cacheWaits()).toHaveLength(0);
      expect(hooks.logged.some((line) => line.includes("LIMITHOLD"))).toBe(true);
      expect(upstream.calls).toEqual([a, a]);
    } finally {
      await db.updateSettings({ limitHoldEnabled: false });
    }
  });

  it("leaves requests that ask for no prompt cache alone", async () => {
    const { a, b } = await addKeys("a", "b");
    await lockForLimit(a, 60_000);
    await chat(body({ cache: false }));
    await unlock(a);
    await chat(body({ cache: false }));
    expect(upstream.calls).toEqual([b, a]);
  });

  it("keeps a session's main conversation on its key when a side request moves", async () => {
    const { a, b } = await addKeys("a", "b");
    await chat(body());
    await lockForLimit(a, 300);

    // Same session, its own system prompt (a subagent): too small to wait.
    await chat(body({ prompt: "You are a search subagent." }));
    expect(upstream.calls).toEqual([a, b]);

    expect((await chat(body())).status).toBe(200);
    expect(upstream.calls).toEqual([a, b, a]);
  });
});

describe("warm key selection", () => {
  const select = (exclude, options) => getProviderCredentials(provider, exclude, MODEL, options);

  it("reports a briefly limited warm key when another key could serve", async () => {
    const { a } = await addKeys("a", "b");
    await lockForLimit(a, 300);
    const picked = await select(new Set(), { warmConnectionIds: [a], maxWarmWaitMs: 1000 });
    expect(picked.warmLimitedUntilMs).toBeGreaterThan(Date.now());
  });

  it("picks a key when it may not wait", async () => {
    const { a, b } = await addKeys("a", "b");
    await lockForLimit(a, 300);
    const picked = await select(new Set(), { warmConnectionIds: [a], maxWarmWaitMs: 0 });
    expect(picked.connectionId).toBe(b);
  });

  it("does not wait for a warm key the first usable key outranks", async () => {
    const { a, b } = await addKeys("a", "b");
    await lockForLimit(b, 300);
    const picked = await select(new Set(), { warmConnectionIds: [b], maxWarmWaitMs: 1000 });
    expect(picked.warmLimitedUntilMs).toBeUndefined();
    expect(picked.connectionId).toBe(a);
  });

  it("does not wait for a warm key when a key ranked ahead of it frees up first", async () => {
    const { p1, p2, p3 } = await addKeys("p1", "p2", "p3");
    await lockForLimit(p1, 300);
    await lockForLimit(p2, 600);
    const picked = await select(new Set(), { warmConnectionIds: [p2], maxWarmWaitMs: 1000 });
    expect(picked.warmLimitedUntilMs).toBeUndefined();
    expect(picked.connectionId).toBe(p3);

    // p1 now frees up after p2: waiting for p2 pays off.
    await lockForLimit(p1, 900);
    const waits = await select(new Set(), { warmConnectionIds: [p2], maxWarmWaitMs: 1000 });
    expect(waits.warmLimitedUntilMs).toBeGreaterThan(Date.now());
  });

  it("does not wait for a warm key whose Antigravity quota is used up", async () => {
    provider = "antigravity";
    const { a, b } = await addKeys("a", "b");
    await lockForLimit(a, 300);
    const quotas = getAntigravityQuotaCache();
    quotas.set(a, { [MODEL]: { remainingPercentage: 0, resetAt: new Date(Date.now() + 3_600_000).toISOString() } });
    try {
      const picked = await select(new Set(), { warmConnectionIds: [a], maxWarmWaitMs: 1000 });
      expect(picked.warmLimitedUntilMs).toBeUndefined();
      expect(picked.connectionId).toBe(b);
    } finally {
      quotas.delete(a);
      await db.deleteProviderConnectionsByProvider("antigravity");
    }
  });

  it("leaves a claimed demotion probe alone", async () => {
    const { a, c } = await addKeys("a", "b", "c");
    const past = new Date(Date.now() - 60_000).toISOString();
    await db.updateProviderConnection(a, {
      [db.getAuthDemoteKey(MODEL)]: { demotedAt: past, firstAt: past, nextProbeAt: past },
    });
    await lockForLimit(c, 300);
    // a is due its probe; c, the only warm key, is briefly limited.
    const picked = await select(new Set(), { warmConnectionIds: [c], maxWarmWaitMs: 1000 });
    expect(picked.warmLimitedUntilMs).toBeUndefined();
    expect(picked.connectionId).toBe(a);
  });

  it("goes the all-locked way when the other key is excluded or filtered out", async () => {
    const { a, b } = await addKeys("a", "b");
    await lockForLimit(a, 300);
    const excluded = await select(new Set([b]), { warmConnectionIds: [a], maxWarmWaitMs: 1000 });
    expect(excluded.allRateLimited).toBe(true);
    const filtered = await select(new Set(), { warmConnectionIds: [a], maxWarmWaitMs: 1000, connectionFilter: (c) => c.id !== b });
    expect(filtered.allRateLimited).toBe(true);
  });
});

describe("warm keys under soonest-reset", () => {
  const select = (options) => getProviderCredentials(provider, new Set(), MODEL, options);
  const resetIn = (id, ms) => resets.set(id, { weeklyReset: Date.now() + ms });

  it("picks a usable key with a sooner reset over a warm key with a later one", async () => {
    await withSoonestReset(async () => {
      const { k1, k2 } = await addKeys("k1", "k2");
      resetIn(k1, 7 * DAY);
      resetIn(k2, DAY);
      expect((await select({ warmConnectionIds: [k1], maxWarmWaitMs: 1000 })).connectionId).toBe(k2);
    });
  });

  it("lets priority decide when resets are unknown", async () => {
    await withSoonestReset(async () => {
      const { k1, k2 } = await addKeys("k1", "k2");
      expect((await select({ warmConnectionIds: [k2], maxWarmWaitMs: 1000 })).connectionId).toBe(k1);
    });
  });

  it("does not wait for a warm key that resets later than the usable pick", async () => {
    await withSoonestReset(async () => {
      const { k1, k2 } = await addKeys("k1", "k2");
      resetIn(k1, 7 * DAY);
      resetIn(k2, DAY);
      await lockForLimit(k1, 300);
      const picked = await select({ warmConnectionIds: [k1], maxWarmWaitMs: 1000 });
      expect(picked.warmLimitedUntilMs).toBeUndefined();
      expect(picked.connectionId).toBe(k2);
    });
  });

  it("waits for a warm key that resets sooner, unless one resetting sooner still frees up first", async () => {
    await withSoonestReset(async () => {
      const { k1, k2, k3 } = await addKeys("k1", "k2", "k3");
      resetIn(k1, 60 * 60 * 1000);
      resetIn(k2, DAY);
      resetIn(k3, 7 * DAY);
      await lockForLimit(k1, 300);
      await lockForLimit(k2, 600);
      const picked = await select({ warmConnectionIds: [k2], maxWarmWaitMs: 1000 });
      expect(picked.warmLimitedUntilMs).toBeUndefined();
      expect(picked.connectionId).toBe(k3);

      await lockForLimit(k1, 900);
      expect((await select({ warmConnectionIds: [k2], maxWarmWaitMs: 1000 })).warmLimitedUntilMs).toBeGreaterThan(Date.now());
    });
  });
});

describe("conversation key", () => {
  const key = (b, headers = {}, extra = {}) => affinity.cacheAffinityKey({ provider: "p", model: "m", body: b, headers, ...extra });
  const turn = (extra = [], system = "system prompt") => ({
    system: [{ type: "text", text: system }],
    messages: [
      { role: "user", content: [{ type: "text", text: "first", ...(extra.length ? {} : { cache_control: { type: "ephemeral" } }) }] },
      ...extra,
    ],
  });
  const later = (system) => turn([
    { role: "assistant", content: "ok" },
    { role: "user", content: [{ type: "text", text: "second", cache_control: { type: "ephemeral" } }] },
  ], system);

  it("is the same on every turn of a conversation without a session id", () => {
    expect(key(turn())).toBeTruthy();
    expect(key(later())).toBe(key(turn()));
  });

  it("ignores Claude Code's per-request billing header", () => {
    const billed = (cch) => ({
      system: [
        { type: "text", text: `x-anthropic-billing-header: cc_version=2.1.0.abc; cc_entrypoint=cli; cch=${cch};` },
        { type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(key(billed("aaaaa"))).toBe(key(billed("bbbbb")));
  });

  it("differs per session, model, provider and tenant, and holds no content", () => {
    const b = body({ session: SESSION });
    const k = key(b);
    expect(k).toMatch(/^[0-9a-f]{32}$/);
    expect(key(body({ session: OTHER_SESSION }))).not.toBe(k);
    expect(affinity.cacheAffinityKey({ provider: "p", model: "other", body: b })).not.toBe(k);
    expect(affinity.cacheAffinityKey({ provider: "q", model: "m", body: b })).not.toBe(k);
    expect(key(b, {}, { tenant: "client-key-1" })).not.toBe(k);
    expect(key(b, {}, { tenant: "client-key-1" })).not.toBe(key(b, {}, { tenant: "client-key-2" }));
  });

  it("gives a session's subagents keys of their own", () => {
    expect(key(body({ prompt: "You are a search subagent." }))).not.toBe(key(body()));
  });

  it("reads the Claude Code session from the header or a JSON user_id too", () => {
    const start = turn();
    const fromMetadata = key({ ...start, metadata: { user_id: `user_abc_account__session_${SESSION}` } });
    expect(key(start, { "x-claude-code-session-id": SESSION })).toBe(fromMetadata);
    expect(key({ ...start, metadata: { user_id: JSON.stringify({ session_id: SESSION }) } })).toBe(fromMetadata);
    expect(fromMetadata).not.toBe(key(start));
  });

  it("does not take a bare user id or a per-request id for a session", () => {
    const user = (id) => ({ metadata: { user_id: id } });
    expect(resolveClientSessionId({ body: user("user-1"), strict: true })).toBeNull();
    expect(resolveClientSessionId({ body: user("user-1") })).toBe("user-1");
    expect(key({ ...turn(), ...user("user-1") })).toBe(key({ ...turn(), ...user("user-2") }));
    const b = turn();
    expect(key(b, { "x-client-request-id": "req-1" })).toBe(key(b, { "x-client-request-id": "req-2" }));
  });

  it("covers prompt_cache_key and Responses bodies", () => {
    const responses = (instructions) => ({
      instructions,
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      prompt_cache_key: "conv-1",
    });
    expect(key(responses("Be terse."))).toMatch(/^[0-9a-f]{32}$/);
    expect(key(responses("Be verbose."))).not.toBe(key(responses("Be terse.")));
  });

  it("hashes the whole conversation start, however long", () => {
    const shared = "x".repeat(40 * 1024);
    expect(key(turn([], `${shared} one`))).not.toBe(key(turn([], `${shared} two`)));
  });

  it("is null without a prompt cache, for Codex, or when turned off", () => {
    expect(key({ messages: [{ role: "user", content: "hi" }] })).toBeNull();
    expect(affinity.cacheAffinityKey({ provider: "codex", model: "m", body: turn() })).toBeNull();
    CACHE_AFFINITY.ttlMs = 0;
    expect(key(turn())).toBeNull();
  });
});

describe("warm key memory", () => {
  it("forgets a key after the 5-minute TTL", () => {
    vi.useFakeTimers();
    affinity.rememberWarmKey("k", "conn-a", affinity.cacheTtlMs(body()));
    vi.advanceTimersByTime(5 * 60 * 1000 - 1);
    expect(affinity.getWarmKeys("k")).toEqual(["conn-a"]);
    vi.advanceTimersByTime(2);
    expect(affinity.getWarmKeys("k")).toEqual([]);
  });

  it("keeps a key an hour when the request asks for a 1h cache", () => {
    vi.useFakeTimers();
    const hour = body();
    hour.messages[0].content[0].cache_control = { type: "ephemeral", ttl: "1h" };
    affinity.rememberWarmKey("k", "conn-a", affinity.cacheTtlMs(hour));
    vi.advanceTimersByTime(6 * 60 * 1000);
    expect(affinity.getWarmKeys("k")).toEqual(["conn-a"]);
    vi.advanceTimersByTime(55 * 60 * 1000);
    expect(affinity.getWarmKeys("k")).toEqual([]);
  });

  it("keeps at most maxEntries conversations, dropping the least recently served", () => {
    CACHE_AFFINITY.maxEntries = 3;
    for (const k of ["k1", "k2", "k3"]) affinity.rememberWarmKey(k, `conn-${k}`);
    affinity.rememberWarmKey("k1", "conn-k1");
    affinity.rememberWarmKey("k4", "conn-k4");
    expect(affinity.conversationCount()).toBe(3);
    expect(affinity.getWarmKeys("k2")).toEqual([]);
    expect(affinity.getWarmKeys("k1")).toEqual(["conn-k1"]);
    expect(affinity.getWarmKeys("k4")).toEqual(["conn-k4"]);
  });

  it("keeps at most maxWarmKeys keys per conversation", () => {
    for (const c of ["c1", "c2", "c3", "c4", "c5"]) affinity.rememberWarmKey("k", c);
    expect(affinity.getWarmKeys("k")).toEqual(["c2", "c3", "c4", "c5"]);
  });
});

describe("wait sizing", () => {
  it("adds bounded jitter after the lock", () => {
    vi.useFakeTimers();
    const until = Date.now() + 100;
    expect(affinity.warmWaitMs(until, Infinity, () => 0)).toBe(100 + CACHE_AFFINITY.lockSlackMs);
    const most = affinity.warmWaitMs(until, Infinity, () => 0.99999);
    expect(most).toBeGreaterThan(100 + CACHE_AFFINITY.lockSlackMs);
    expect(most).toBeLessThanOrEqual(100 + CACHE_AFFINITY.lockSlackMs + CACHE_AFFINITY.jitterMs);
  });

  it("keeps lock, slack and jitter within the wait budget", () => {
    vi.useFakeTimers();
    expect(affinity.lockBudgetMs(1000)).toBe(1000 - CACHE_AFFINITY.lockSlackMs);
    const until = Date.now() + affinity.lockBudgetMs(1000);
    expect(affinity.warmWaitMs(until, 1000, () => 0.99999)).toBe(1000);
    expect(affinity.warmWaitMs(until, 1000, () => 0)).toBe(1000);
  });

  it("does not count inline images and files as prompt tokens", () => {
    const image = "A".repeat(1_000_000);
    const withImages = {
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: image } },
          { type: "image_url", image_url: { url: `data:image/png;base64,${image}` } },
          { type: "text", text: "what is this?" },
        ],
      }],
      contents: [{ parts: [{ inlineData: { mimeType: "image/png", data: image } }] }],
      input: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: image, format: "wav" } }] }],
    };
    expect(affinity.estimatePromptTokens(withImages)).toBeLessThan(200);
    expect(affinity.estimatePromptTokens({ messages: [{ role: "user", content: "x".repeat(40_000) }] })).toBeGreaterThanOrEqual(10_000);
  });

  it("gives a small request no wait budget", () => {
    expect(affinity.warmWaitBudget({ waitedMs: 0, promptTokens: () => 999 })).toBe(0);
    expect(affinity.warmWaitBudget({ waitedMs: 400, promptTokens: () => 1000 })).toBe(600);
    expect(affinity.warmWaitBudget({ waitedMs: 1000, promptTokens: () => 1e9 })).toBe(0);
  });
});

describe("env settings", () => {
  const NAMES = ["CACHE_AFFINITY_TTL_MS", "CACHE_AFFINITY_MAX_WAIT_MS", "CACHE_AFFINITY_MIN_TOKENS"];
  const saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
  afterEach(() => {
    for (const n of NAMES) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
    vi.resetModules();
  });
  const fresh = async () => {
    vi.resetModules();
    return {
      config: (await import("open-sse/config/runtimeConfig.js")).CACHE_AFFINITY,
      cache: await import("open-sse/services/cacheAffinity.js"),
    };
  };

  it("turns off with a TTL of 0 and never waits with a max wait of 0", async () => {
    Object.assign(process.env, { CACHE_AFFINITY_TTL_MS: "0", CACHE_AFFINITY_MAX_WAIT_MS: "0", CACHE_AFFINITY_MIN_TOKENS: "5000000000" });
    const { config, cache } = await fresh();
    expect(config).toMatchObject({ ttlMs: 0, maxWaitMs: 0, minPromptTokens: 5_000_000_000 });
    expect(cache.cacheAffinityKey({ provider: "p", model: "m", body: body() })).toBeNull();
    expect(cache.warmWaitBudget({ promptTokens: () => 1e12 })).toBe(0);
  });

  it("keeps the defaults for values it can't read", async () => {
    Object.assign(process.env, { CACHE_AFFINITY_TTL_MS: "soon", CACHE_AFFINITY_MAX_WAIT_MS: "-5", CACHE_AFFINITY_MIN_TOKENS: "1.5" });
    const { config } = await fresh();
    expect(config).toMatchObject({ ttlMs: 5 * 60 * 1000, maxWaitMs: 10 * 1000, minPromptTokens: 32 * 1000 });
  });

  it("keeps the TTL and wait cap for values that aren't plain milliseconds", async () => {
    for (const raw of ["5m", "3e5", "0x1000", "1e4"]) {
      Object.assign(process.env, { CACHE_AFFINITY_TTL_MS: raw, CACHE_AFFINITY_MAX_WAIT_MS: raw });
      const { config } = await fresh();
      expect(config).toMatchObject({ ttlMs: 5 * 60 * 1000, maxWaitMs: 10 * 1000 });
    }
  });

  it("keeps the token threshold for a blank or non-decimal value", async () => {
    for (const raw of ["   ", "1e3", "0x10"]) {
      process.env.CACHE_AFFINITY_MIN_TOKENS = raw;
      const { config } = await fresh();
      expect(config.minPromptTokens).toBe(32 * 1000);
    }
  });
});
