// A key whose upstream sent no response headers in time. One request tries at
// most one more key after it, so a request too slow for the model can't lock
// every key. Streaming header timeouts from two requests on two keys mark the
// model hung: new requests for it then fail at once until a probe, sent to keys
// that haven't stalled, gets an answer.
//
// Runs the real account loop (handleChat → auth.js against a temporary
// database); only the upstream call (handleChatCore) is stubbed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-headers-timeout-"));
const originalDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = tempDir;
delete global._dbAdapter;

// script: one-off results, in order; stalled: keys whose upstream never sends
// headers; pending: a result the next call waits on. Anything else succeeds.
const upstream = vi.hoisted(() => ({ calls: [], script: [], stalled: new Set(), pending: null }));
const combos = vi.hoisted(() => new Map());
vi.mock("open-sse/handlers/chatCore.js", async (importOriginal) => ({
  ...(await importOriginal()),
  handleChatCore: async (args) => {
    upstream.calls.push(`${args.connectionId}:${args.modelInfo.model}`);
    const stream = args.body?.stream === true;
    const pending = upstream.pending;
    upstream.pending = null;
    if (pending) return pending;
    const next = upstream.script.shift();
    if (next) return next(stream);
    if (upstream.stalled.has(args.connectionId)) return noHeaders(stream);
    await args.onRequestSuccess?.();
    return { success: true, response: new Response("{}", { status: 200 }) };
  },
}));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: async (m) => (m.includes("/") ? { provider: m.split("/")[0], model: m.split("/")[1] } : { provider: null, model: m }),
  getComboModels: async (m) => combos.get(m) ?? null,
  comboLookupName: (name) => name,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_p, c) => c,
  updateProviderCredentials: async () => {},
}));

const db = await import("@/lib/db/index.js");
const { handleChat } = await import("@/sse/handlers/chat.js");
const { markAccountUnavailable } = await import("@/sse/services/auth.js");
const { TRANSIENT_COOLDOWN_MS } = await import("open-sse/config/errorConfig.js");

const MODEL = "big-model";
const OTHER_MODEL = "big-model-mini";
// What chatCore returns when the executor's header timer fired (pinned in chat-core-failure-detail.test.js).
const NO_HEADERS = "[504]: upstream sent no response headers in 240s (headers timeout, set by UPSTREAM_STREAM_HEADERS_TIMEOUT_MS)";
// HEADERS_TIMEOUT values, kept literal so this file runs on any branch.
const FIRST_WINDOW_MS = 2 * 60 * 1000;
const SECOND_WINDOW_MS = 5 * 60 * 1000;
const PROBE_LEASE_MS = 10 * 60 * 1000;
const PAST_KEY_LOCK_MS = TRANSIENT_COOLDOWN_MS + 1000;
let providerSeq = 0;
let provider;

function serverError() {
  return { success: false, status: 500, error: "[500]: upstream error", response: new Response('{"error":{"message":"upstream error"}}', { status: 500 }) };
}

function noHeaders(stream) {
  return {
    success: false,
    status: 504,
    error: NO_HEADERS,
    headersTimeout: { stream },
    response: new Response(JSON.stringify({ error: { message: NO_HEADERS } }), { status: 504 }),
  };
}

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
  // A fresh provider (and keys) per test, so no lock or hang state leaks between tests.
  provider = `openai-compatible-acme-${++providerSeq}`;
  upstream.calls = [];
  upstream.script = [];
  upstream.stalled = new Set();
  upstream.pending = null;
  combos.clear();
});

afterEach(async () => {
  vi.useRealTimers();
  await db.updateSettings({ limitHoldEnabled: false });
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

function chat(model = `${provider}/${MODEL}`, { stream = true } = {}) {
  return handleChat(new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream, messages: [{ role: "user", content: "fix the bug" }] }),
  }));
}

const calls = (...ids) => ids.map((id) => `${id}:${MODEL}`);
const errorOf = async (res) => (await res.clone().json()).error?.message || "";
const later = (ms) => vi.setSystemTime(Date.now() + ms);

async function connection(id) {
  return (await db.getProviderConnections({ provider })).find((c) => c.id === id);
}
const lockEnd = async (id, model = MODEL) => new Date((await connection(id))?.[`modelLock_${model}`] || 0).getTime();

// Keys a, b and c stall. Request 1 times out on a and b; past their locks,
// request 2 tries them last and times out on c: two requests on two keys, so
// the model is hung. Key d is left healthy.
async function hangModel({ a, b, c }) {
  vi.useFakeTimers({ toFake: ["Date"] });
  upstream.stalled = new Set([a, b, c]);
  expect((await chat()).status).toBe(504);
  later(PAST_KEY_LOCK_MS);
  const marking = await chat();
  expect(upstream.calls).toEqual(calls(a, b, c));
  return marking;
}

describe("header timeout in the account loop", () => {
  it("tries one more key, then answers 504, leaving the other keys for the next request", async () => {
    const { a, b, c } = await addKeys("a", "b", "c");
    upstream.stalled = new Set([a, b]);

    expect((await chat()).status).toBe(504);
    expect(upstream.calls).toEqual(calls(a, b));
    expect((await chat()).status).toBe(200);
    expect(upstream.calls).toEqual(calls(a, b, c));
  });

  it("answers the per-request 504 without a limit hold", async () => {
    await db.updateSettings({ limitHoldEnabled: true });
    const { a, b } = await addKeys("a", "b", "c");
    upstream.stalled = new Set([a, b]);

    const res = await chat();
    await res.body?.cancel();
    expect(res.status).toBe(504);
    expect(upstream.calls).toEqual(calls(a, b));
  });

  it("locks the key on that model for the usual transient cooldown", async () => {
    const { a, b } = await addKeys("a", "b");
    upstream.stalled = new Set([a]);
    const before = Date.now();

    expect((await chat()).status).toBe(200);
    expect(upstream.calls).toEqual(calls(a, b));
    expect(await lockEnd(a)).toBeGreaterThanOrEqual(before + TRANSIENT_COOLDOWN_MS);
    expect(await lockEnd(a)).toBeLessThanOrEqual(Date.now() + TRANSIENT_COOLDOWN_MS);
    expect(await lockEnd(a, OTHER_MODEL)).toBe(0);
  });

  it("keeps a longer lock, and its limit flag, when a late header timeout lands in it", async () => {
    const { a } = await addKeys("a");
    await markAccountUnavailable(a, 429, "rate limit exceeded", provider, MODEL, Date.now() + 10 * 60 * 1000);
    const end = await lockEnd(a);

    await markAccountUnavailable(a, 504, NO_HEADERS, provider, MODEL);
    const conn = await connection(a);
    expect(await lockEnd(a)).toBe(end);
    expect(conn[`modelLimit_${MODEL}`]).toBe(true);
    expect(conn[`modelNoHeaders_${MODEL}`]).toBeFalsy();
  });

  it("answers 504 without a limit hold when only header timeouts lock the keys", async () => {
    await db.updateSettings({ limitHoldEnabled: true });
    const { a } = await addKeys("a");
    await markAccountUnavailable(a, 504, NO_HEADERS, provider, MODEL);
    // The key's last error is now another model's 429.
    await markAccountUnavailable(a, 429, "rate limit exceeded", provider, OTHER_MODEL);

    const res = await chat();
    await res.body?.cancel();
    expect(res.status).toBe(504);
    expect(upstream.calls).toEqual([]);
  });

  it("forgets earlier header timeouts once the model serves a request", async () => {
    const { a, b, c } = await addKeys("a", "b", "c", "d");
    // Request 1 times out on a and succeeds on b; request 2 times out on b.
    upstream.script = [noHeaders];
    expect((await chat()).status).toBe(200);
    upstream.script = [noHeaders];
    expect((await chat()).status).toBe(200);
    expect(upstream.calls).toEqual(calls(a, b, b, c));
  });

  it("has the next request try first the keys whose stream didn't just time out", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { a, b, c } = await addKeys("a", "b", "c");
    upstream.stalled = new Set([a, b]);
    expect((await chat()).status).toBe(504);
    later(PAST_KEY_LOCK_MS);

    expect((await chat()).status).toBe(200);
    expect(upstream.calls).toEqual(calls(a, b, c));
  });

  it("doesn't mark the model hung for slow non-streaming replies", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { a, b } = await addKeys("a", "b", "c");
    upstream.stalled = new Set([a, b]);
    expect((await chat(undefined, { stream: false })).status).toBe(504);
    later(PAST_KEY_LOCK_MS);
    expect((await chat(undefined, { stream: false })).status).toBe(504);
    later(PAST_KEY_LOCK_MS);

    upstream.stalled = new Set();
    expect((await chat()).status).toBe(200);
    expect(upstream.calls).toEqual(calls(a, b, a, b, a));
  });
});

describe("hung model", () => {
  it("tells the request that found the hang when to come back", async () => {
    const keys = await addKeys("a", "b", "c", "d");
    const marking = await hangModel(keys);

    expect(marking.status).toBe(504);
    expect(await errorOf(marking)).toMatch(/not responding upstream.*set by UPSTREAM_STREAM_HEADERS_TIMEOUT_MS.*next check in \d+s/);
    expect(Number(marking.headers.get("retry-after"))).toBe(FIRST_WINDOW_MS / 1000);
  });

  it("fails new requests at once, without calling the upstream", async () => {
    const keys = await addKeys("a", "b", "c", "d");
    await hangModel(keys);

    const res = await chat();
    expect(res.status).toBe(504);
    expect(await errorOf(res)).toMatch(/not responding upstream.*next check in \d+s/);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(upstream.calls).toHaveLength(3);
  });

  it("fails at once without a limit hold, even with the hold on", async () => {
    const keys = await addKeys("a", "b", "c", "d");
    await hangModel(keys);
    await db.updateSettings({ limitHoldEnabled: true });

    const res = await chat();
    await res.body?.cancel();
    expect(res.status).toBe(504);
    expect(upstream.calls).toHaveLength(3);
  });

  it("sends the probe to a key that hasn't stalled; its success ends the hang", async () => {
    const keys = await addKeys("a", "b", "c", "d");
    await hangModel(keys);
    later(FIRST_WINDOW_MS + 1000);

    expect((await chat()).status).toBe(200);
    expect(upstream.calls.at(-1)).toBe(`${keys.d}:${MODEL}`);
    upstream.stalled = new Set();
    expect((await chat()).status).toBe(200);
    expect(upstream.calls.at(-1)).toBe(`${keys.a}:${MODEL}`);
  });

  it("starts a longer window when the probe times out too", async () => {
    const keys = await addKeys("a", "b", "c", "d");
    await hangModel(keys);
    upstream.stalled.add(keys.d);
    later(FIRST_WINDOW_MS + 1000);

    expect((await chat()).status).toBe(504);
    expect(upstream.calls).toHaveLength(4);
    later(FIRST_WINDOW_MS + 1000);
    expect((await chat()).status).toBe(504);
    expect(upstream.calls).toHaveLength(4);

    later(SECOND_WINDOW_MS - FIRST_WINDOW_MS);
    upstream.stalled = new Set();
    expect((await chat()).status).toBe(200);
    expect(upstream.calls).toHaveLength(5);
  });

  it("runs one probe at a time, until its lease runs out", async () => {
    const keys = await addKeys("a", "b", "c", "d");
    await hangModel(keys);
    later(FIRST_WINDOW_MS + 1000);

    let answer;
    upstream.pending = new Promise((resolve) => { answer = resolve; });
    const probe = chat();
    await vi.waitFor(() => expect(upstream.calls).toHaveLength(4));

    const res = await chat();
    expect(res.status).toBe(504);
    expect(await errorOf(res)).toMatch(/a check is running/);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(upstream.calls).toHaveLength(4);

    later(PROBE_LEASE_MS);
    expect((await chat()).status).toBe(200);
    expect(upstream.calls).toHaveLength(5);

    answer({ success: true, response: new Response("{}", { status: 200 }) });
    await probe;
  });

  it("lets a combo move on to its next model", async () => {
    const keys = await addKeys("a", "b", "c", "d");
    await hangModel(keys);
    combos.set("big-combo", [`${provider}/${MODEL}`, `${provider}/${OTHER_MODEL}`]);
    upstream.stalled = new Set();

    expect((await chat("big-combo")).status).toBe(200);
    expect(upstream.calls).toHaveLength(4);
    expect(upstream.calls.at(-1)).toBe(`${keys.a}:${OTHER_MODEL}`);
  });

  it("lets the next request probe at once when the probe ends some other way", async () => {
    const keys = await addKeys("a", "b", "c", "d");
    await hangModel(keys);
    later(FIRST_WINDOW_MS + 1000);

    upstream.script = Array(4).fill(serverError);
    expect((await chat()).status).not.toBe(200);
    expect(upstream.calls).toHaveLength(7);
    later(PAST_KEY_LOCK_MS);
    upstream.stalled = new Set();
    expect((await chat()).status).toBe(200);
    expect(upstream.calls).toHaveLength(8);
  });
});

describe("keys a stream just stalled on", () => {
  it("are still used when the only other key is rate-limited", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { a, b } = await addKeys("a", "b");
    await markAccountUnavailable(b, 429, "rate limit exceeded", provider, MODEL, Date.now() + 10 * 60 * 1000);
    upstream.script = [noHeaders];
    await chat();
    later(PAST_KEY_LOCK_MS);

    expect((await chat()).status).toBe(200);
    expect(upstream.calls).toEqual(calls(a, a));
  });

  it("go before a key demoted on the model", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { a, d } = await addKeys("a", "d");
    // Request 1: a's stream gets no headers, d fails some other way.
    upstream.script = [noHeaders, serverError];
    await chat();
    later(PAST_KEY_LOCK_MS);
    const iso = (ms) => new Date(Date.now() + ms).toISOString();
    await db.updateProviderConnection(d, {
      [`authDemote_${MODEL}`]: { firstAt: iso(-60 * 60 * 1000), demotedAt: iso(-30 * 60 * 1000), count: 5, reason: "403", probeLevel: 0, nextProbeAt: iso(60 * 60 * 1000) },
    });

    expect((await chat()).status).toBe(200);
    expect(upstream.calls).toEqual(calls(a, d, a));
  });
});

describe("a header timeout inside a longer rate-limit lock", () => {
  it("leaves the all-locked answer the rate limit's", async () => {
    const { a } = await addKeys("a");
    await markAccountUnavailable(a, 429, "rate limit exceeded", provider, MODEL, Date.now() + 10 * 60 * 1000);
    await markAccountUnavailable(a, 504, NO_HEADERS, provider, MODEL);

    expect((await chat(undefined, { stream: false })).status).toBe(429);
    expect(upstream.calls).toEqual([]);
  });
});
