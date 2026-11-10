// Prompt-cache affinity: a conversation stays on the key (account) holding its
// upstream prompt cache, and waits out a short rate-limit lock on that key
// instead of rebuilding the cache on the next one.
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

const db = await import("@/lib/db/index.js");
const { handleChat } = await import("@/sse/handlers/chat.js");
const { markAccountUnavailable } = await import("@/sse/services/auth.js");
const { CACHE_AFFINITY } = await import("open-sse/config/runtimeConfig.js");
const affinity = await import("open-sse/services/cacheAffinity.js");

const MODEL = "claude-test";
const SESSION = "0b3c5d7e-1111-4222-8333-944455556666";
const DEFAULTS = { ...CACHE_AFFINITY };
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
  affinity.clearCacheHolders();
  Object.assign(CACHE_AFFINITY, { maxWaitMs: 1000, minPromptTokens: 1000 });
});

afterEach(() => {
  vi.useRealTimers();
  Object.assign(CACHE_AFFINITY, DEFAULTS);
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

describe("cache affinity routing", () => {
  it("keeps a conversation on the key that served it, not the first by priority", async () => {
    const { a, b } = await addKeys("a", "b");
    await lockForLimit(a, 60_000);
    expect((await chat(body())).status).toBe(200);
    expect(upstream.calls).toEqual([b]);

    await db.updateProviderConnection(a, { [`modelLock_${MODEL}`]: null });
    expect((await chat(body())).status).toBe(200);
    expect(upstream.calls).toEqual([b, b]);

    // Another conversation still starts on the first key.
    await chat(body({ session: "aaaaaaaa-0000-4000-8000-000000000000" }));
    expect(upstream.calls).toEqual([b, b, a]);
  });

  it("waits out a short limit lock on the cache holder instead of moving", async () => {
    const { a } = await addKeys("a", "b");
    await chat(body());
    await lockForLimit(a, 300);

    const started = Date.now();
    expect((await chat(body())).status).toBe(200);
    expect(upstream.calls).toEqual([a, a]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it("retries the cache holder after its own short 429", async () => {
    const { a } = await addKeys("a", "b");
    await chat(body());

    upstream.script = [limited(300)];
    expect((await chat(body())).status).toBe(200);
    expect(upstream.calls).toEqual([a, a, a]);
  });

  it("moves to the next key when the lock outlasts the wait cap", async () => {
    const { a, b } = await addKeys("a", "b");
    await chat(body());

    upstream.script = [limited(5_000)];
    const started = Date.now();
    expect((await chat(body())).status).toBe(200);
    expect(upstream.calls).toEqual([a, a, b]);
    expect(Date.now() - started).toBeLessThan(1000);
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
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    const res = await chat(body(), { signal: controller.signal });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(res.ok).toBe(false);
    expect(upstream.calls).toEqual([a]);
  });

  it("changes nothing with a single key", async () => {
    const { a } = await addKeys("a");
    await chat(body());
    await lockForLimit(a, 300);

    const started = Date.now();
    const res = await chat(body());
    expect(res.status).toBe(429);
    expect(Date.now() - started).toBeLessThan(250);
    expect(upstream.calls).toEqual([a]);
  });

  it("leaves requests that ask for no prompt cache alone", async () => {
    const { a, b } = await addKeys("a", "b");
    await lockForLimit(a, 60_000);
    await chat(body({ cache: false }));
    await db.updateProviderConnection(a, { [`modelLock_${MODEL}`]: null });
    await chat(body({ cache: false }));
    expect(upstream.calls).toEqual([b, a]);
  });
});

describe("conversation key", () => {
  const key = (b, headers = {}) => affinity.cacheAffinityKey({ provider: "p", model: "m", body: b, headers });
  const turn = (extra = []) => ({
    system: [{ type: "text", text: "system prompt" }],
    messages: [
      { role: "user", content: [{ type: "text", text: "first", ...(extra.length ? {} : { cache_control: { type: "ephemeral" } }) }] },
      ...extra,
    ],
  });

  it("is the same on every turn of a conversation without a session id", () => {
    const later = turn([
      { role: "assistant", content: "ok" },
      { role: "user", content: [{ type: "text", text: "second", cache_control: { type: "ephemeral" } }] },
    ]);
    expect(key(turn())).toBeTruthy();
    expect(key(later)).toBe(key(turn()));
  });

  it("differs per session, model and provider, and holds no content", () => {
    const b = body({ session: SESSION });
    const k = key(b);
    expect(k).toMatch(/^[0-9a-f]{32}$/);
    expect(key(body({ session: "aaaaaaaa-0000-4000-8000-000000000000" }))).not.toBe(k);
    expect(affinity.cacheAffinityKey({ provider: "p", model: "other", body: b })).not.toBe(k);
    expect(affinity.cacheAffinityKey({ provider: "q", model: "m", body: b })).not.toBe(k);
    // The session id names the conversation, whatever the prompt says.
    expect(key(body({ session: SESSION, prompt: "something else entirely" }))).toBe(k);
  });

  it("ignores a per-request id", () => {
    const b = turn();
    expect(key(b, { "x-client-request-id": "req-1" })).toBe(key(b, { "x-client-request-id": "req-2" }));
  });

  it("is null without a prompt cache, for Codex, or when turned off", () => {
    expect(key({ messages: [{ role: "user", content: "hi" }] })).toBeNull();
    expect(affinity.cacheAffinityKey({ provider: "codex", model: "m", body: turn() })).toBeNull();
    CACHE_AFFINITY.ttlMs = 0;
    expect(key(turn())).toBeNull();
  });
});

describe("holder memory", () => {
  it("forgets a conversation after the TTL", () => {
    vi.useFakeTimers();
    affinity.rememberCacheHolder("k", "conn-a");
    vi.advanceTimersByTime(CACHE_AFFINITY.ttlMs - 1);
    expect(affinity.getCacheHolder("k")).toBe("conn-a");
    vi.advanceTimersByTime(2);
    expect(affinity.getCacheHolder("k")).toBeNull();
  });

  it("keeps at most maxEntries, dropping the least recently served", () => {
    CACHE_AFFINITY.maxEntries = 3;
    for (const k of ["k1", "k2", "k3"]) affinity.rememberCacheHolder(k, `conn-${k}`);
    affinity.rememberCacheHolder("k1", "conn-k1");
    affinity.rememberCacheHolder("k4", "conn-k4");
    expect(affinity.cacheHolderCount()).toBe(3);
    expect(affinity.getCacheHolder("k2")).toBeNull();
    expect(affinity.getCacheHolder("k1")).toBe("conn-k1");
    expect(affinity.getCacheHolder("k4")).toBe("conn-k4");
  });
});
