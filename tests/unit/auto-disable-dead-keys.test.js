// A key whose auth keeps failing, on models another key of the provider is
// serving, is turned off (with a reason) instead of being retried every time its
// per-model lock expires. It comes back on when the user re-enables it or puts
// in a new key, not when a connection test passes. Runs against the real SQLite repo.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: { json: (body, init = {}) => new Response(JSON.stringify(body), { status: init.status || 200 }) },
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
// beforeNextWrite(fn) runs fn right before the next updateProviderConnection
// call made through localDb (auth.js), to land a write in between.
const writeHooks = vi.hoisted(() => []);
const beforeNextWrite = (fn) => writeHooks.push(fn);
vi.mock("@/lib/localDb", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    updateProviderConnection: async (...args) => {
      await writeHooks.shift()?.(...args);
      return real.updateProviderConnection(...args);
    },
  };
});

const originalDataDir = process.env.DATA_DIR;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-auto-disable-"));
process.env.DATA_DIR = tempDir;

const PROVIDER = "openai-compatible-chat-test-dead-keys";
const DEAD_403 = '[403]: {"code":"003001","message":"Not authorized for this endpoint"}';
const MIN = 60 * 1000;

let db, auth, testSingleConnection, testBatch, putConnection;
let seq = 0;

beforeAll(async () => {
  db = await import("@/lib/db/index.js");
  auth = await import("@/sse/services/auth.js");
  ({ testSingleConnection } = await import("@/app/api/providers/[id]/test/testUtils.js"));
  ({ POST: testBatch } = await import("@/app/api/providers/test-batch/route.js"));
  ({ PUT: putConnection } = await import("@/app/api/providers/[id]/route.js"));
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

let provider;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-23T00:44:00.000Z"));
  provider = `${PROVIDER}-${++seq}`;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  writeHooks.length = 0;
});

async function addKey(name, extra = {}) {
  return db.createProviderConnection({
    provider, authType: "apikey", name, apiKey: `sk-test-${name}-0123456789`,
    providerSpecificData: { baseUrl: "https://dead-keys.test/v1" }, ...extra,
  });
}

const load = (id) => db.getProviderConnectionById(id);
const succeed = async (id, model) => auth.clearAccountError(id, await load(id), model);
const failOnce = (id, model, status = 403, text = DEAD_403) => auth.markAccountUnavailable(id, status, text, provider, model);

// One request every `stepMs`, cycling through `models`: each healthy peer
// serves it, then the dead key is refused.
async function fail(id, { times, models, peers = [], status = 403, text = DEAD_403, stepMs = 3 * MIN }) {
  for (let i = 0; i < times; i++) {
    if (i > 0) vi.advanceTimersByTime(stepMs);
    const model = models[i % models.length];
    for (const peer of peers) await succeed(peer.id, model);
    await failOnce(id, model, status, text);
  }
}

describe("auth-dead keys turn off", () => {
  it("turns off a key refused on two models another key serves", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 5, models: ["claude-opus-5-5", "kimi-k3"], peers: [healthy] });

    const conn = await load(dead.id);
    expect(conn.isActive).toBe(false);
    expect(conn.autoDisabledAt).toBe(new Date().toISOString());
    expect(conn.autoDisabledReason).toBe('403 "Not authorized for this endpoint" on claude-opus-5-5, kimi-k3');
    expect((await load(healthy.id)).isActive).toBe(true);
  });

  it("trips once the failures span 10 minutes, not at 9", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 5, models: ["m1", "m2"], peers: [healthy], stepMs: 2.25 * MIN });
    expect((await load(dead.id)).isActive).toBe(true);

    const other = await addKey("c");
    await fail(other.id, { times: 5, models: ["m1", "m2"], peers: [healthy], stepMs: 2.5 * MIN });
    expect((await load(other.id)).isActive).toBe(false);
  });

  it("keeps the last active key on, with only the model lock", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 4, models: ["m1", "m2"], peers: [healthy] });
    // The peer served these models, then the user turned it off.
    await db.updateProviderConnection(healthy.id, { isActive: false });
    await fail(dead.id, { times: 2, models: ["m1", "m2"], peers: [healthy] });

    const conn = await load(dead.id);
    expect(conn.isActive).toBe(true);
    expect(conn.authFailCount).toBe(6);
    expect(conn).not.toHaveProperty("autoDisabledAt");
    expect(conn.modelLock_m2).toBeTruthy();
  });

  it("keeps one key on when the last two trip at the same moment", async () => {
    const a = await addKey("a");
    const b = await addKey("b");
    const healthy = await addKey("c");
    for (let i = 0; i < 4; i++) {
      if (i > 0) vi.advanceTimersByTime(3 * MIN);
      const model = i % 2 ? "m2" : "m1";
      await succeed(healthy.id, model);
      await failOnce(a.id, model);
      await failOnce(b.id, model);
    }
    await succeed(healthy.id, "m1");
    await db.updateProviderConnection(healthy.id, { isActive: false });
    vi.advanceTimersByTime(3 * MIN);
    await Promise.all([failOnce(a.id, "m1"), failOnce(b.id, "m1")]);

    const active = [await load(a.id), await load(b.id)].filter((c) => c.isActive !== false);
    expect(active).toHaveLength(1);
  });

  it("leaves a key the user turns off between the trip decision and its write as a manual disable", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 4, models: ["m1", "m2"], peers: [healthy] });
    vi.advanceTimersByTime(3 * MIN);
    await succeed(healthy.id, "m1");
    beforeNextWrite(() => db.updateProviderConnection(dead.id, { isActive: false }));
    await failOnce(dead.id, "m1");

    const conn = await load(dead.id);
    expect(conn.isActive).toBe(false);
    expect(conn).not.toHaveProperty("autoDisabledAt");
    expect(conn).not.toHaveProperty("autoDisabledReason");
  });

  it("keeps the last active key on when its peer is turned off between the decision and the write", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 4, models: ["m1", "m2"], peers: [healthy] });
    vi.advanceTimersByTime(3 * MIN);
    await succeed(healthy.id, "m1");
    beforeNextWrite(() => db.updateProviderConnection(healthy.id, { isActive: false }));
    await failOnce(dead.id, "m1");
    expect((await load(dead.id)).isActive).toBe(true);
  });

  it("leaves a key the user turns off mid-request as a manual disable", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 4, models: ["m1", "m2"], peers: [healthy] });
    vi.advanceTimersByTime(3 * MIN);
    await succeed(healthy.id, "m1");
    const pending = failOnce(dead.id, "m1");
    await db.updateProviderConnection(dead.id, { isActive: false });
    await pending;

    const conn = await load(dead.id);
    expect(conn.isActive).toBe(false);
    expect(conn).not.toHaveProperty("autoDisabledAt");
  });

  it("counts model ids with a colon, like openrouter's :free models", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 5, models: ["a/x:free", "b/y:free"], peers: [healthy] });
    expect((await load(dead.id)).isActive).toBe(false);
  });

  it("keeps a key refused on a single model on", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 10, models: ["claude-opus-5-5"], peers: [healthy] });
    expect((await load(dead.id)).isActive).toBe(true);
  });

  it("starts over after a success on any model", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 4, models: ["m1", "m2"], peers: [healthy] });
    await succeed(dead.id, "m3");
    expect(await load(dead.id)).toMatchObject({
      authFailCount: null, authFailFirstAt: null, authFailLastAt: null, authFailModels: null,
    });

    vi.advanceTimersByTime(3 * MIN);
    await fail(dead.id, { times: 4, models: ["m1", "m2"], peers: [healthy] });
    expect((await load(dead.id)).isActive).toBe(true);
  });

  it.each([
    ["no streak fields left behind", (id) => ({ id })],
    ["an active test status", (id) => ({ id, testStatus: "active" })],
  ])("clears an open streak on success with %s", async (_label, snapshot) => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 3, models: ["m1", "m2"], peers: [healthy] });
    await auth.clearAccountError(dead.id, { ...snapshot(dead.id), authFailCount: 3 }, "m1");
    expect((await load(dead.id)).authFailCount).toBeNull();
  });

  it("resets instead of tripping when the key succeeded after the streak began", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 4, models: ["m1", "m2"], peers: [healthy] });
    // A long request picked before the streak began finishes fine: its
    // snapshot has no streak or error, so the DB is not cleared.
    vi.advanceTimersByTime(MIN);
    await auth.clearAccountError(dead.id, { id: dead.id }, "m3");
    expect((await load(dead.id)).authFailCount).toBe(4);

    vi.advanceTimersByTime(2 * MIN);
    await fail(dead.id, { times: 1, models: ["m1"], peers: [healthy] });
    const conn = await load(dead.id);
    expect(conn.isActive).toBe(true);
    expect(conn.authFailCount).toBe(1);
  });

  it.each([
    [429, "Too many requests"],
    [500, "Internal server error"],
    [402, "Payment required"],
    [400, "Bad request"],
    [403, "You exceeded your current quota"],
    [403, '{"error":{"message":"Key limit exceeded (daily limit)","code":403}}'],
    [403, "You have reached your monthly spend limit"],
    [403, "Your credits are exhausted"],
    [403, "Usage cap reached for this key"],
    [403, "Billing account is inactive"],
    [403, "Model is overloaded, try again later"],
    [403, "Not enough capacity for this request"],
    [403, "Too many requests from this account"],
  ])("never counts %i %s", async (status, text) => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 8, models: ["m1", "m2"], peers: [healthy], status, text });

    const conn = await load(dead.id);
    expect(conn.isActive).toBe(true);
    expect(conn).not.toHaveProperty("authFailCount");
  });

  it("does not reset the streak on a non-auth error in between", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 3, models: ["m1", "m2"], peers: [healthy] });
    await failOnce(dead.id, "m1", 429, "Too many requests");
    vi.advanceTimersByTime(3 * MIN);
    await fail(dead.id, { times: 2, models: ["m1", "m2"], peers: [healthy] });
    expect((await load(dead.id)).isActive).toBe(false);
  });

  it("trips on 401s for one model, still needing the count and window", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 4, models: ["m1"], peers: [healthy], status: 401, text: "Invalid API key" });
    expect((await load(dead.id)).isActive).toBe(true);
    vi.advanceTimersByTime(3 * MIN);
    await fail(dead.id, { times: 1, models: ["m1"], peers: [healthy], status: 401, text: "Invalid API key" });

    const conn = await load(dead.id);
    expect(conn.isActive).toBe(false);
    expect(conn.autoDisabledReason).toBe('401 "Invalid API key" on m1');
  });

  it("does not let a final 401 skip the two-model rule for 403s", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 5, models: ["m1"], peers: [healthy] });
    vi.advanceTimersByTime(3 * MIN);
    await fail(dead.id, { times: 1, models: ["m1"], peers: [healthy], status: 401, text: "Invalid API key" });

    const conn = await load(dead.id);
    expect(conn.authFailCount).toBe(6);
    expect(conn.isActive).toBe(true);
  });

  it("does not let one earlier 401 skip the two-model rule for 403s", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 1, models: ["m1"], peers: [healthy], status: 401, text: "Invalid API key" });
    vi.advanceTimersByTime(3 * MIN);
    await fail(dead.id, { times: 6, models: ["m1"], peers: [healthy] });
    expect((await load(dead.id)).isActive).toBe(true);
  });

  it.each([
    "Not authorized for this endpoint",
    "Copilot is not enabled for this account",
  ])("counts the 403 %s", async (text) => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 5, models: ["m1", "m2"], peers: [healthy], text });
    expect((await load(dead.id)).isActive).toBe(false);
  });

  it("trips a dead key retried every 2 minutes after 10 minutes, not before", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 5, models: ["claude-opus-5-5", "kimi-k3"], peers: [healthy], stepMs: 2 * MIN });
    expect((await load(dead.id)).isActive).toBe(true);
    vi.advanceTimersByTime(2 * MIN);
    await fail(dead.id, { times: 1, models: ["claude-opus-5-5"], peers: [healthy] });
    expect((await load(dead.id)).isActive).toBe(false);
  });

  it("counts two failures in the same millisecond with a peer success between", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await succeed(healthy.id, "m1");
    await failOnce(dead.id, "m1");
    await succeed(healthy.id, "m1");
    await failOnce(dead.id, "m1");
    expect((await load(dead.id)).authFailCount).toBe(2);
  });

  it("does not count a second failure in the same millisecond with no peer success between", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await succeed(healthy.id, "m1");
    await failOnce(dead.id, "m1");
    await failOnce(dead.id, "m1");
    expect((await load(dead.id)).authFailCount).toBe(1);
  });

  it.each([
    [9, 3],
    [10, 3],
    [11, 1],
  ])("after a %i-minute gap between counted failures, the streak is at %i", async (gapMinutes, count) => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 2, models: ["m1", "m2"], peers: [healthy], stepMs: 2 * MIN });
    vi.advanceTimersByTime(gapMinutes * MIN);
    await fail(dead.id, { times: 1, models: ["m1"], peers: [healthy] });
    expect((await load(dead.id)).authFailCount).toBe(count);
  });

  it.each([
    ["a garbage first", { authFailFirstAt: "not-a-date", authFailLastAt: -1 }],
    ["a garbage last", { authFailFirstAt: -5, authFailLastAt: "not-a-date" }],
    ["a future first", { authFailFirstAt: "2099-01-01T00:00:00.000Z", authFailLastAt: -1 }],
    ["a future last", { authFailFirstAt: -5, authFailLastAt: "2099-01-01T00:00:00.000Z" }],
  ])("starts over from %s streak timestamp and still trips", async (_label, stored) => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    // Numbers are minutes before now; strings are stored as-is.
    const at = (v) => (typeof v === "number" ? new Date(Date.now() + v * MIN).toISOString() : v);
    await db.updateProviderConnection(dead.id, {
      authFailCount: 4, authFailModels: ["m1", "m2"],
      authFailFirstAt: at(stored.authFailFirstAt), authFailLastAt: at(stored.authFailLastAt),
    });
    await fail(dead.id, { times: 1, models: ["m1"], peers: [healthy] });
    expect(await load(dead.id)).toMatchObject({ authFailCount: 1, authFailFirstAt: new Date().toISOString() });

    vi.advanceTimersByTime(3 * MIN);
    await fail(dead.id, { times: 4, models: ["m2", "m1"], peers: [healthy] });
    expect((await load(dead.id)).isActive).toBe(false);
  });

  it("drops a streak left over from an old outage", async () => {
    const backup = await addKey("a");
    const healthy = await addKey("b");
    await fail(backup.id, { times: 4, models: ["m1", "m2"], peers: [healthy], stepMs: 2 * MIN });
    expect((await load(backup.id)).authFailCount).toBe(4);

    // Not picked again until a short blip three days later.
    vi.advanceTimersByTime(3 * 24 * 60 * MIN);
    await fail(backup.id, { times: 1, models: ["m1"], peers: [healthy] });
    const conn = await load(backup.id);
    expect(conn.isActive).toBe(true);
    expect(conn.authFailCount).toBe(1);
  });
});

describe("a refusal only counts when another key serves that model", () => {
  it("disables no key when every key is refused (region block)", async () => {
    const keys = [await addKey("a"), await addKey("b"), await addKey("c")];
    for (const k of keys) for (const m of ["m1", "m2"]) await succeed(k.id, m);
    vi.advanceTimersByTime(MIN);
    for (let i = 0; i < 12; i++) {
      for (const k of keys) await failOnce(k.id, i % 2 ? "m2" : "m1");
      vi.advanceTimersByTime(2.5 * MIN);
    }
    for (const k of keys) expect((await load(k.id)).isActive).toBe(true);
  });

  it("disables neither of two keys that die at once, even concurrently", async () => {
    const keys = [await addKey("a"), await addKey("b")];
    for (const k of keys) for (const m of ["m1", "m2"]) await succeed(k.id, m);
    vi.advanceTimersByTime(MIN);
    for (let i = 0; i < 8; i++) {
      await Promise.all(keys.map((k) => failOnce(k.id, i % 2 ? "m2" : "m1")));
      vi.advanceTimersByTime(2.5 * MIN);
    }
    for (const k of keys) expect((await load(k.id)).isActive).toBe(true);
  });

  it("keeps a key on whose 403s are on models no other key served", async () => {
    const limited = await addKey("a");
    const healthy = await addKey("b");
    for (let i = 0; i < 8; i++) {
      if (i > 0) vi.advanceTimersByTime(2.5 * MIN);
      await succeed(healthy.id, "m-common");
      await failOnce(limited.id, i % 2 ? "m-plan-2" : "m-plan-1");
    }
    expect((await load(limited.id)).isActive).toBe(true);
    expect(await load(limited.id)).not.toHaveProperty("authFailCount");
  });

  it.each([
    ["counts", 10, 1],
    ["does not count", 11, undefined],
  ])("%s a key's first refusal of a model a peer served %i minutes before", async (_label, minutes, count) => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await succeed(healthy.id, "m1");
    vi.advanceTimersByTime(minutes * MIN);
    await failOnce(dead.id, "m1");
    expect((await load(dead.id)).authFailCount).toBe(count);
  });

  // The peers are serving. A gets a refusal, B and C serve once 20s later, then
  // the provider refuses every key, one request every 2 minutes.
  it.each([
    ["three keys, 401s on one model", ["a", "b", "c"], ["m1"], 401, "Invalid API key"],
    ["three keys, 403s on two models", ["a", "b", "c"], ["m1", "m2"], 403, DEAD_403],
    ["two keys, 401s on one model", ["a", "b"], ["m1"], 401, "Invalid API key"],
    ["two keys, 403s on two models", ["a", "b"], ["m1", "m2"], 403, DEAD_403],
  ])("disables no key in an outage that starts just after one peer success (%s)", async (_label, names, models, status, text) => {
    const [a, ...peers] = await Promise.all(names.map((n) => addKey(n)));
    for (const peer of peers) for (const m of models) await succeed(peer.id, m);
    vi.advanceTimersByTime(MIN);
    await failOnce(a.id, models[0], status, text);
    vi.advanceTimersByTime(20 * 1000);
    for (const peer of peers) for (const m of models) await succeed(peer.id, m);
    for (let i = 0; i < 12; i++) {
      vi.advanceTimersByTime(2 * MIN);
      for (const k of [a, ...peers]) await failOnce(k.id, models[i % models.length], status, text);
    }
    for (const k of [a, ...peers]) expect((await load(k.id)).isActive).toBe(true);
  });

  it("still trips a dead key whose peer serves each request after it fails", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    for (const m of ["m1", "m2"]) await succeed(healthy.id, m);
    for (let i = 0; i < 6; i++) {
      if (i > 0) vi.advanceTimersByTime(2 * MIN);
      const model = i % 2 ? "m2" : "m1";
      await failOnce(dead.id, model);
      await succeed(healthy.id, model);
    }
    const conn = await load(dead.id);
    expect(conn.authFailCount).toBe(6);
    expect(conn.isActive).toBe(false);
  });

  const viaProxy = (url) => ({
    providerSpecificData: { baseUrl: "https://dead-keys.test/v1", connectionProxyEnabled: true, connectionProxyUrl: url },
  });

  it("keeps a key on whose proxy is refused while a direct key serves", async () => {
    const proxied = await addKey("a", viaProxy("http://proxy-x.test:8080"));
    const direct = await addKey("b");
    await fail(proxied.id, { times: 6, models: ["m1", "m2"], peers: [direct] });
    const conn = await load(proxied.id);
    expect(conn.isActive).toBe(true);
    expect(conn).not.toHaveProperty("authFailCount");
  });

  it("trips a key refused while a key on the same proxy serves", async () => {
    const dead = await addKey("a", viaProxy("http://proxy-x.test:8080"));
    const healthy = await addKey("b", viaProxy("http://proxy-x.test:8080"));
    await fail(dead.id, { times: 6, models: ["m1", "m2"], peers: [healthy] });
    expect((await load(dead.id)).isActive).toBe(false);
  });

  it("never counts web search or fetch lock keys", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 8, models: [`websearch:${provider}`, `webfetch:${provider}`], peers: [healthy] });
    const conn = await load(dead.id);
    expect(conn.isActive).toBe(true);
    expect(conn).not.toHaveProperty("authFailCount");
  });
});

describe("an auto-disabled key", () => {
  async function deadKey() {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 5, models: ["m1", "m2"], peers: [healthy] });
    expect((await load(dead.id)).isActive).toBe(false);
    return dead;
  }

  async function expectBackOn(id) {
    const conn = await load(id);
    expect(conn.isActive).toBe(true);
    for (const field of ["autoDisabledAt", "autoDisabledReason", "authFailCount", "authFailFirstAt", "authFailLastAt", "authFailModels"]) {
      expect(conn).not.toHaveProperty(field);
    }
  }

  const stubFetch = (status) => vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status })));
  const runTestAll = async () => {
    const res = await testBatch(new Request("http://localhost/api/providers/test-batch", {
      method: "POST", body: JSON.stringify({ mode: "provider", providerId: provider }),
    }));
    return (await res.json()).results.map((r) => r.connectionId);
  };

  it("stays off, with its reason, through other updates and errors", async () => {
    const dead = await deadKey();
    const { autoDisabledAt, autoDisabledReason } = await load(dead.id);
    vi.advanceTimersByTime(3 * MIN);
    await db.updateProviderConnection(dead.id, { priority: 3, lastError: "something else" });
    await failOnce(dead.id, "m1", 429, "Too many requests");
    // A request already in flight when it tripped fails the same way.
    const peer = (await db.getProviderConnections({ provider })).find((c) => c.id !== dead.id);
    await succeed(peer.id, "m3");
    await failOnce(dead.id, "m3", 401, "Invalid API key");
    const conn = await load(dead.id);
    expect(conn.isActive).toBe(false);
    expect(conn.autoDisabledAt).toBe(autoDisabledAt);
    expect(conn.autoDisabledReason).toBe(autoDisabledReason);
  });

  it("clears the reason and streak when re-enabled", async () => {
    const dead = await deadKey();
    await db.updateProviderConnection(dead.id, { isActive: true });
    await expectBackOn(dead.id);
  });

  it("clears the reason and streak when re-enabled from the dashboard", async () => {
    const dead = await deadKey();
    const res = await putConnection(
      new Request(`http://localhost/api/providers/${dead.id}`, { method: "PUT", body: JSON.stringify({ isActive: true }) }),
      { params: Promise.resolve({ id: dead.id }) },
    );
    expect(res.status).toBe(200);
    await expectBackOn(dead.id);
  });

  // What the edit dialog sends when saving a key.
  const editBody = (apiKey) => ({ name: "a", apiKey, testStatus: "active", lastError: null, lastErrorAt: null });

  it("re-enables when a new key is pasted in", async () => {
    const dead = await deadKey();
    await db.updateProviderConnection(dead.id, editBody("sk-test-new"));
    await expectBackOn(dead.id);
  });

  it("re-enables when a new key is pasted in from the dashboard", async () => {
    const dead = await deadKey();
    const res = await putConnection(
      new Request(`http://localhost/api/providers/${dead.id}`, { method: "PUT", body: JSON.stringify(editBody("sk-test-new")) }),
      { params: Promise.resolve({ id: dead.id }) },
    );
    expect(res.status).toBe(200);
    await expectBackOn(dead.id);
  });

  it("stays off when the same key is saved again", async () => {
    const dead = await deadKey();
    await db.updateProviderConnection(dead.id, editBody("sk-test-a-0123456789"));
    const conn = await load(dead.id);
    expect(conn.isActive).toBe(false);
    expect(conn.autoDisabledReason).toBeTruthy();
  });

  it("stays off when the same key is saved again with stray whitespace", async () => {
    const dead = await deadKey();
    await db.updateProviderConnection(dead.id, editBody(" sk-test-a-0123456789 "));
    expect((await load(dead.id)).isActive).toBe(false);
  });

  it("treats a new key saved with isActive false as a manual disable", async () => {
    const dead = await deadKey();
    await db.updateProviderConnection(dead.id, { ...editBody("sk-test-new"), isActive: false });
    const conn = await load(dead.id);
    expect(conn.isActive).toBe(false);
    expect(conn.autoDisabledAt).toBeUndefined();
  });

  it("leaves a key the user turned off alone when a new key is pasted in", async () => {
    const manual = await addKey("a", { isActive: false });
    await db.updateProviderConnection(manual.id, editBody("sk-test-new"));
    expect((await load(manual.id)).isActive).toBe(false);
  });

  it("re-enables when the key is added again", async () => {
    const dead = await deadKey();
    await db.createProviderConnection({ provider, authType: "apikey", name: "a", apiKey: "sk-test-new-0123456789" });
    await expectBackOn(dead.id);
  });

  it("stays off, with its reason, when its connection test passes", async () => {
    const dead = await deadKey();
    const { autoDisabledReason } = await load(dead.id);
    stubFetch(200);
    expect((await testSingleConnection(dead.id)).valid).toBe(true);
    const conn = await load(dead.id);
    expect(conn.isActive).toBe(false);
    expect(conn.autoDisabledReason).toBe(autoDisabledReason);
  });

  it("stays off when a Claude OAuth test refreshes its expired token with a 200", async () => {
    const conn = await db.createProviderConnection({
      provider: "claude", authType: "oauth", name: "auto-off", accessToken: "test-access-token",
      refreshToken: "test-refresh-token", expiresAt: new Date(Date.now() - MIN).toISOString(),
    });
    await db.updateProviderConnection(conn.id, {
      isActive: false, autoDisabledAt: new Date().toISOString(), autoDisabledReason: "401",
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ access_token: "test-access-token-2", expires_in: 3600 }), { status: 200 },
    )));
    expect(await testSingleConnection(conn.id)).toMatchObject({ valid: true, refreshed: true });
    expect(await load(conn.id)).toMatchObject({ isActive: false, autoDisabledReason: "401" });
    await db.deleteProviderConnection(conn.id);
  });

  it("is skipped by Test all, like a key the user turned off", async () => {
    const dead = await deadKey();
    const manual = await addKey("c", { isActive: false });
    stubFetch(200);
    const tested = await runTestAll();
    expect(tested).not.toContain(dead.id);
    expect(tested).not.toContain(manual.id);
    expect((await load(dead.id)).isActive).toBe(false);
  });

  it("comes back clean when toggled on after a passing test", async () => {
    const dead = await deadKey();
    stubFetch(200);
    await testSingleConnection(dead.id);
    await db.updateProviderConnection(dead.id, { isActive: true });
    await expectBackOn(dead.id);
  });

  it("becomes a manual disable when the user also turns it off", async () => {
    const dead = await deadKey();
    await db.updateProviderConnection(dead.id, { isActive: false });
    const conn = await load(dead.id);
    expect(conn.isActive).toBe(false);
    expect(conn).not.toHaveProperty("autoDisabledAt");
    expect(conn).not.toHaveProperty("autoDisabledReason");
  });

  it("leaves a key the user turned off alone when its test passes", async () => {
    const manual = await addKey("a", { isActive: false });
    stubFetch(200);
    expect((await testSingleConnection(manual.id)).valid).toBe(true);
    expect((await load(manual.id)).isActive).toBe(false);
  });
});
