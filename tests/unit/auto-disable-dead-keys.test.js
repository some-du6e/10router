// An API key whose auth keeps failing, on models another key of the provider is
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
const localDbWrites = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/lib/localDb", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    updateProviderConnection: async (...args) => {
      localDbWrites.count++;
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

let db, auth, testSingleConnection, testBatch, putConnection, withToggledActive, connectionsToTest;
let seq = 0;

beforeAll(async () => {
  db = await import("@/lib/db/index.js");
  auth = await import("@/sse/services/auth.js");
  ({ testSingleConnection } = await import("@/app/api/providers/[id]/test/testUtils.js"));
  ({ POST: testBatch } = await import("@/app/api/providers/test-batch/route.js"));
  ({ PUT: putConnection } = await import("@/app/api/providers/[id]/route.js"));
  ({ withToggledActive, connectionsToTest } = await import("@/app/(dashboard)/dashboard/providers/utils.js"));
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

  it("starts the streak over when a new key is pasted into a key that is still on", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 4, models: ["m1", "m2"], peers: [healthy] });
    await db.updateProviderConnection(dead.id, { apiKey: "sk-test-new-0123456789" });
    expect(await load(dead.id)).not.toHaveProperty("authFailCount");

    vi.advanceTimersByTime(3 * MIN);
    await fail(dead.id, { times: 1, models: ["m1"], peers: [healthy] });
    const conn = await load(dead.id);
    expect(conn.isActive).toBe(true);
    expect(conn.authFailCount).toBe(1);
  });

  it("keeps the streak when the same key is saved again", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 3, models: ["m1", "m2"], peers: [healthy] });
    await db.updateProviderConnection(dead.id, { apiKey: " sk-test-a-0123456789 " });
    expect((await load(dead.id)).authFailCount).toBe(3);
  });

  it("does not blame a newly pasted key for a failure the old key's request brings back", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 4, models: ["m1", "m2"], peers: [healthy] });
    const oldKey = (await load(dead.id)).apiKey;
    await db.updateProviderConnection(dead.id, { apiKey: "sk-test-new-0123456789" });
    vi.advanceTimersByTime(3 * MIN);
    await succeed(healthy.id, "m1");
    await auth.markAccountUnavailable(dead.id, 403, DEAD_403, provider, "m1", null, oldKey);
    const conn = await load(dead.id);
    expect(conn.isActive).toBe(true);
    expect(conn).not.toHaveProperty("authFailCount");
  });

  it("does not turn off a key pasted in between the trip decision and its write", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 4, models: ["m1", "m2"], peers: [healthy] });
    vi.advanceTimersByTime(3 * MIN);
    await succeed(healthy.id, "m1");
    beforeNextWrite(() => db.updateProviderConnection(dead.id, { apiKey: "sk-test-new-0123456789" }));
    await failOnce(dead.id, "m1");
    const conn = await load(dead.id);
    expect(conn.isActive).toBe(true);
    expect(conn).not.toHaveProperty("autoDisabledAt");
    expect(conn).not.toHaveProperty("authFailCount");
  });

  it("writes nothing on later successes once a model lock is cleared", async () => {
    const key = await addKey("a");
    await failOnce(key.id, "m1", 429, "Too many requests");
    const before = localDbWrites.count;
    await succeed(key.id, "m1");
    expect(localDbWrites.count).toBe(before + 1);
    expect(await load(key.id)).toMatchObject({ modelLock_m1: null, testStatus: "active" });

    await succeed(key.id, "m1");
    await succeed(key.id, "m2");
    expect(localDbWrites.count).toBe(before + 1);
  });

  it("writes nothing on successes while another model is still locked after a manual clear", async () => {
    const key = await addKey("a");
    await failOnce(key.id, "m1", 429, "Too many requests");
    await failOnce(key.id, "m2", 429, "Too many requests");
    // What the clear-cooldown route writes: errorCode and m2's lock stay.
    await db.updateProviderConnection(key.id, { modelLock_m1: null, testStatus: "active", lastError: null, lastErrorAt: null, backoffLevel: 0 });
    await succeed(key.id, "m3");
    const before = localDbWrites.count;
    await succeed(key.id, "m3");
    await succeed(key.id, "m3");
    expect(localDbWrites.count).toBe(before);
    expect(await load(key.id)).toMatchObject({ modelLock_m2: expect.any(String) });
  });

  it.each([
    ["the same model", "m1"],
    ["another model", "m3"],
  ])("clears a reset time left behind by a manual lock clear on a success on %s, then stops writing", async (_label, model) => {
    const key = await addKey("a");
    await auth.markAccountUnavailable(key.id, 429, "Too many requests", provider, "m1", Date.now() + 30 * MIN);
    expect(await load(key.id)).toMatchObject({ providerReset_m1: expect.any(String), modelLimit_m1: true });
    // What the clear-cooldown route, codex reset-credits and resetHubQuota write.
    await db.updateProviderConnection(key.id, { modelLock_m1: null });

    const before = localDbWrites.count;
    await succeed(key.id, model);
    expect(await load(key.id)).toMatchObject({ providerReset_m1: null, modelLimit_m1: null });
    expect(localDbWrites.count).toBe(before + 1);
    await succeed(key.id, model);
    await succeed(key.id, "m2");
    expect(localDbWrites.count).toBe(before + 1);
  });

  it.each([
    ["the clear-cooldown route", null],
    ["a row with no test status", { testStatus: null }],
  ])("clears an error code left behind by %s on the next success, then stops writing", async (_label, extra) => {
    const key = await addKey("a", { authType: "oauth", accessToken: "test-access-token" });
    await failOnce(key.id, "m1", 401, "Invalid token");
    const { POST: availability } = await import("@/app/api/models/availability/route.js");
    const res = await availability(new Request("http://localhost/api/models/availability", {
      method: "POST", body: JSON.stringify({ action: "clearCooldown", provider, model: "m1" }),
    }));
    expect(res.status).toBe(200);
    if (extra) await db.updateProviderConnection(key.id, extra);
    expect(await load(key.id)).toMatchObject({ modelLock_m1: null, lastError: null, errorCode: 401 });

    const before = localDbWrites.count;
    await succeed(key.id, "m1");
    expect((await load(key.id)).errorCode).toBeNull();
    expect(localDbWrites.count).toBe(before + 1);
    await succeed(key.id, "m1");
    await succeed(key.id, "m2");
    expect(localDbWrites.count).toBe(before + 1);
  });

  it("still clears an expired lock left on another model", async () => {
    const key = await addKey("a");
    await failOnce(key.id, "m1", 429, "Too many requests");
    await failOnce(key.id, "m2", 429, "Too many requests");
    await succeed(key.id, "m1");
    vi.advanceTimersByTime(60 * MIN);
    await succeed(key.id, "m3");
    expect(await load(key.id)).toMatchObject({ modelLock_m2: null, testStatus: "active", lastError: null });
  });

  it("counts model ids with a colon, like openrouter's :free models", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 5, models: ["a/x:free", "b/y:free"], peers: [healthy] });
    expect((await load(dead.id)).isActive).toBe(false);
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
    [403, '{"error":{"message":"Project \'proj_x\' does not have access to model \'o3\'","code":"model_not_found"}}'],
    [403, '{"error":{"message":"Forbidden","code":"model_not_found"}}'],
    [403, "The model m1 is not available for this key"],
    [403, "This model is not allowed for this project"],
    [401, "model m1 is not enabled for this key"],
    // qoder billing and throttle blocks, as its executor turns them into a 403.
    ...[
      '{"code":"112","message":"Quota exhausted","pricingUrl":"https://qoder.sh/pricing"}',
      '{"code":"10605","message":"Queue limit"}',
      '{"message":"Upgrade required","pricingUrl":"https://..."}',
      '{"message":"Payment required","pricingUrl":"https://..."}',
    ].map((inner) => [403, JSON.stringify({ error: { message: inner, code: 403 } })]),
    [403, "Your plan does not include this endpoint"],
    // Balance and arrears blocks: SiliconFlow, Volcengine Ark / BytePlus.
    [403, '{"code":30001,"message":"Sorry, your account balance is insufficient","data":null}'],
    [403, '{"error":{"code":"AccountOverdueError","message":"The request failed because your account has an overdue balance."}}'],
    [403, '{"error":{"code":"AccountOverdueError","message":"Request failed."}}'],
    [403, "Insufficient balance"],
    [403, "Your account is in arrears"],
    [403, "Unpaid invoice on this account"],
    [403, "Please recharge to continue"],
    [403, "Please top up your account"],
    // Restricted keys refused one operation.
    [401, "You have insufficient permissions for this operation. Missing scopes: api.model.embeddings.request."],
    [403, "Missing scopes: api.responses.write"],
    [403, "Permission denied for this operation"],
    // New-api style relays answer limits with a 401.
    [401, "token quota exhausted, RemainQuota = 0"],
    [401, "Key limit exceeded (daily limit)"],
    [401, "Rate limit reached for requests"],
    [401, "Model is overloaded, try again later"],
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

  it("does not let a final 401 turn off a key 403'd on one model", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 5, models: ["m1"], peers: [healthy] });
    vi.advanceTimersByTime(3 * MIN);
    await fail(dead.id, { times: 1, models: ["m1"], peers: [healthy], status: 401, text: "Invalid API key" });

    const conn = await load(dead.id);
    expect(conn.authFailCount).toBe(1);
    expect(conn.isActive).toBe(true);
  });

  it("does not let one earlier 401 turn off a key 403'd on one model", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 1, models: ["m1"], peers: [healthy], status: 401, text: "Invalid API key" });
    vi.advanceTimersByTime(3 * MIN);
    await fail(dead.id, { times: 6, models: ["m1"], peers: [healthy] });
    expect((await load(dead.id)).isActive).toBe(true);
  });

  it.each([
    [403, "Not authorized for this endpoint"],
    [403, "Copilot is not enabled for this account"],
    [401, "Invalid API key"],
    [401, "Incorrect API key provided: sk-test-****. You can find your API key at https://platform.openai.com/account/api-keys."],
    [403, "API key not valid. Please pass a valid API key."],
    [401, "Your API key has been disabled"],
    [403, "Your API key has been revoked"],
    [403, "This account has been deactivated"],
  ])("counts the %i %s", async (status, text) => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 5, models: ["m1", "m2"], peers: [healthy], status, text });
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

// A 403 on one model may mean the key lacks only that model, so the key stays
// on and is demoted on that model: other keys are tried first.
describe("a key refused on only one model", () => {
  const demotion = (conn, model = "m1") => conn[`authDemote_${model}`] ?? null;
  const demotedMin = (conn, model = "m1") => (new Date(demotion(conn, model)?.until || 0).getTime() - Date.now()) / MIN;
  const lockedMin = (conn, model = "m1") => (new Date(conn[`modelLock_${model}`] || 0).getTime() - Date.now()) / MIN;
  const pick = async (model) => (await auth.getProviderCredentials(provider, null, model))?.connectionId;
  const takePeerAway = (healthy) => db.updateProviderConnection(healthy.id, { isActive: false });
  const MESSAGE = 'm1 demoted for 1h after repeated 403 "Not authorized for this endpoint"';
  const revoked = { status: 401, text: "Invalid API key" };

  async function demotedKey(model = "m1") {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 5, models: [model], peers: [healthy] });
    expect(demotedMin(await load(dead.id), model)).toBe(60);
    return { dead, healthy };
  }

  // After a demotion ends, the next request on that model is refused again.
  async function refuseAfterDemotion(dead, healthy, model = "m1") {
    vi.setSystemTime(new Date(demotion(await load(dead.id), model).until).getTime() + MIN);
    await succeed(healthy.id, model);
    await failOnce(dead.id, model);
    return load(dead.id);
  }

  // Refusals every stepMs until the key is turned off, for up to totalMs.
  async function failUntilOff(id, peer, { model = "m1", stepMs = 3 * MIN, totalMs = 2 * 60 * MIN, ...rest }) {
    for (let t = 0; t <= totalMs; t += stepMs) {
      await fail(id, { times: 1, models: [model], peers: [peer], ...rest });
      if ((await load(id)).isActive === false) return t / MIN;
      vi.advanceTimersByTime(stepMs);
    }
    return null;
  }

  it("demotes the key on that model for an hour instead of turning it off, and keeps it first for others", async () => {
    const { warn } = await import("@/sse/utils/logger.js");
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 4, models: ["claude-opus-5-5"], peers: [healthy] });
    expect(demotion(await load(dead.id), "claude-opus-5-5")).toBeNull();
    vi.advanceTimersByTime(3 * MIN);
    await fail(dead.id, { times: 1, models: ["claude-opus-5-5"], peers: [healthy] });

    const conn = await load(dead.id);
    expect(conn).toMatchObject({
      isActive: true, "authDemote_claude-opus-5-5": { level: 1 },
      lastError: 'claude-opus-5-5 demoted for 1h after repeated 403 "Not authorized for this endpoint"',
    });
    expect(conn).not.toHaveProperty("autoDisabledAt");
    expect(demotedMin(conn, "claude-opus-5-5")).toBe(60);
    expect(lockedMin(conn, "claude-opus-5-5")).toBe(2);
    expect(warn).toHaveBeenCalledWith("AUTH", "a demoted on claude-opus-5-5 for 1h after repeated 403s");
    expect(await pick("kimi-k3")).toBe(dead.id);
    vi.advanceTimersByTime(3 * MIN);
    expect(await pick("claude-opus-5-5")).toBe(healthy.id);
  });

  it("demotes once a run of 5 spans 10 minutes, not at 9", async () => {
    const early = await addKey("a");
    const healthy = await addKey("b");
    await fail(early.id, { times: 5, models: ["m1"], peers: [healthy], stepMs: 2.25 * MIN });
    expect(demotion(await load(early.id))).toBeNull();

    const late = await addKey("c");
    await fail(late.id, { times: 5, models: ["m1"], peers: [healthy], stepMs: 2.5 * MIN });
    expect(demotedMin(await load(late.id))).toBe(60);
  });

  it("needs an hour, not 10 minutes, while only a key on another upstream serves", async () => {
    const dead = await addKey("a", { providerSpecificData: { baseUrl: "https://own.dead-keys.test/v1" } });
    const healthy = await addKey("b");
    await fail(dead.id, { times: 24, models: ["m1"], peers: [healthy], stepMs: 2.5 * MIN });
    expect(demotion(await load(dead.id))).toBeNull();
    vi.advanceTimersByTime(2.5 * MIN);
    await fail(dead.id, { times: 1, models: ["m1"], peers: [healthy] });
    expect(demotedMin(await load(dead.id))).toBe(60);
  });

  it("doubles the demotion on each refusal after one ends, up to 24 hours", async () => {
    const { dead, healthy } = await demotedKey();
    const hours = [1];
    for (let i = 0; i < 6; i++) hours.push(demotedMin(await refuseAfterDemotion(dead, healthy)) / 60);
    expect(hours).toEqual([1, 2, 4, 8, 16, 24, 24]);
    expect(await load(dead.id)).toMatchObject({ isActive: true, authDemote_m1: { level: 7 } });
  });

  it.each([
    ["ended longer ago than it lasted", 61, 0],
    ["ended within as long as it lasted", 59, 120],
  ])("starts the level over for a demotion that %s", async (_label, minutesAgo, expected) => {
    const { dead, healthy } = await demotedKey();
    vi.setSystemTime(new Date(demotion(await load(dead.id)).until).getTime() + minutesAgo * MIN);
    await fail(dead.id, { times: 1, models: ["m1"], peers: [healthy] });
    expect(Math.max(0, demotedMin(await load(dead.id)))).toBe(expected);
  });

  it("starts the level over for a level 4 demotion that ended 30 days ago", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    const ended = Date.now() - 30 * 24 * 60 * MIN;
    const old = { level: 4, until: new Date(ended).toISOString(), at: new Date(ended - 8 * 60 * MIN).toISOString() };
    await db.updateProviderConnection(dead.id, { authDemote_m1: old });
    await fail(dead.id, { times: 1, models: ["m1"], peers: [healthy] });
    expect(demotion(await load(dead.id))).toEqual(old);
    expect(await pick("m1")).toBe(healthy.id);
    vi.advanceTimersByTime(3 * MIN);
    expect(await pick("m1")).toBe(dead.id);
  });

  it("does not raise a running demotion on a refusal from a request sent before it", async () => {
    const { dead, healthy } = await demotedKey();
    const before = demotion(await load(dead.id));
    vi.advanceTimersByTime(MIN);
    await succeed(healthy.id, "m1");
    await failOnce(dead.id, "m1");
    expect(demotion(await load(dead.id))).toEqual(before);
  });

  it("raises the demotion once when two refusals after it ends race", async () => {
    const { dead, healthy } = await demotedKey();
    vi.setSystemTime(new Date(demotion(await load(dead.id)).until).getTime() + MIN);
    await succeed(healthy.id, "m1");
    beforeNextWrite(async () => {
      vi.advanceTimersByTime(1000);
      await succeed(healthy.id, "m1");
      await failOnce(dead.id, "m1");
    });
    await failOnce(dead.id, "m1");
    const conn = await load(dead.id);
    expect(demotion(conn).level).toBe(2);
    expect(demotedMin(conn)).toBeCloseTo(120, 1);
  });

  it("does not raise a demotion that a success on that model lifted while the refusal was on its way", async () => {
    const { dead, healthy } = await demotedKey();
    vi.setSystemTime(new Date(demotion(await load(dead.id)).until).getTime() + MIN);
    await succeed(healthy.id, "m1");
    beforeNextWrite(() => succeed(dead.id, "m1"));
    await failOnce(dead.id, "m1");
    expect(demotion(await load(dead.id))).toBeNull();
  });

  it("lifts a demotion written while a success on that model, read before it, was on its way", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 4, models: ["m1"], peers: [healthy] });
    const before = await load(dead.id);
    vi.advanceTimersByTime(3 * MIN);
    beforeNextWrite(() => fail(dead.id, { times: 1, models: ["m1"], peers: [healthy] }));
    await auth.clearAccountError(dead.id, before, "m1");
    expect(demotion(await load(dead.id))).toBeNull();
  });

  it.each([
    ["the same request's snapshot", async (id) => succeed(id, "m1")],
    ["a snapshot that predates the demotion", async (id) => auth.clearAccountError(id, { id }, "m1")],
  ])("lifts the demotion and starts its level over on a success on that model, read from %s", async (_label, success) => {
    const { dead, healthy } = await demotedKey();
    vi.advanceTimersByTime(3 * MIN);
    await success(dead.id);
    expect(await pick("m1")).toBe(dead.id);
    await fail(dead.id, { times: 1, models: ["m1"], peers: [healthy] });
    vi.advanceTimersByTime(3 * MIN);
    expect(await pick("m1")).toBe(dead.id);
  });

  it("lifts the demotion on a success on that model after a success elsewhere cleared the error", async () => {
    const { dead } = await demotedKey();
    vi.advanceTimersByTime(3 * MIN);
    await succeed(dead.id, "m2");
    expect(await load(dead.id)).toMatchObject({ lastError: null, testStatus: "active", authDemote_m1: { level: 1 } });
    await succeed(dead.id, "m1");
    expect(demotion(await load(dead.id))).toBeNull();
  });

  it("does not raise a demotion on a 401, even once it has ended", async () => {
    const { dead, healthy } = await demotedKey();
    const before = demotion(await load(dead.id));
    vi.setSystemTime(new Date(before.until).getTime() + 15 * MIN);
    await fail(dead.id, { times: 1, models: ["m2"], peers: [healthy] });
    vi.advanceTimersByTime(MIN);
    await fail(dead.id, { times: 1, models: ["m1"], peers: [healthy], ...revoked });
    expect(await load(dead.id)).toMatchObject({ isActive: true, authFailModels: ["m2", "m1"], authDemote_m1: before });
  });

  it("keeps the demotion and its level through a success on another model, then doubles it on the next refusal", async () => {
    const { dead, healthy } = await demotedKey();
    const before = demotion(await load(dead.id));
    await succeed(dead.id, "m2");
    expect(await load(dead.id)).toMatchObject({ authFailCount: null, authDemote_m1: before });
    expect(demotedMin(await refuseAfterDemotion(dead, healthy))).toBe(120);
  });

  it.each([
    ["a new key is pasted in", (id) => db.updateProviderConnection(id, { apiKey: "sk-test-new-0123456789" })],
    ["the key is toggled off and on", async (id) => {
      await db.updateProviderConnection(id, { isActive: false });
      await db.updateProviderConnection(id, { isActive: true });
    }],
  ])("lifts every demotion when %s, even after a success on another model", async (_label, change) => {
    const { dead, healthy } = await demotedKey();
    await refuseAfterDemotion(dead, healthy);
    await succeed(dead.id, "m2");
    await change(dead.id);
    expect(demotion(await load(dead.id))).toBeNull();
    vi.advanceTimersByTime(3 * MIN);
    expect(await pick("m1")).toBe(dead.id);
  });

  it("shows a running demotion as a cooldown on the dashboard after the short lock ends", async () => {
    const { dead } = await demotedKey();
    vi.advanceTimersByTime(3 * MIN);
    const { GET } = await import("@/app/api/models/availability/route.js");
    const listed = (await (await GET()).json()).models.filter((m) => m.connectionId === dead.id);
    expect(listed).toEqual([expect.objectContaining({ model: "m1", status: "cooldown" })]);
  });

  it.each([
    ["while it runs", 3],
    ["after it ended", 61],
  ])("clears a demotion, with its level, from the dashboard %s", async (_label, laterMin) => {
    const { dead, healthy } = await demotedKey();
    const { POST } = await import("@/app/api/models/availability/route.js");
    vi.advanceTimersByTime(laterMin * MIN);
    // A success elsewhere tidies the expired short lock away; the demotion stays.
    await succeed(dead.id, "m2");
    expect(await load(dead.id)).toMatchObject({ modelLock_m1: null, authDemote_m1: { level: 1 } });
    const res = await POST(new Request("http://localhost/api/models/availability", {
      method: "POST", body: JSON.stringify({ action: "clearCooldown", provider, model: "m1" }),
    }));
    expect(res.status).toBe(200);
    expect(demotion(await load(dead.id))).toBeNull();
    await fail(dead.id, { times: 1, models: ["m1"], peers: [healthy] });
    expect(demotion(await load(dead.id))?.level ?? 1).toBe(1);
  });

  it("does not demote the last active key", async () => {
    const { warn } = await import("@/sse/utils/logger.js");
    warn.mockClear();
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 4, models: ["m1"], peers: [healthy] });
    await takePeerAway(healthy);
    await fail(dead.id, { times: 3, models: ["m1"], peers: [healthy] });
    const conn = await load(dead.id);
    expect(conn).toMatchObject({ isActive: true, authFailCount: 7 });
    expect(demotion(conn)).toBeNull();
    expect(warn.mock.calls.filter(([, line]) => line.includes("demoted"))).toEqual([]);
  });

  it("does not demote the key when its peer is turned off between the decision and the write", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 4, models: ["m1"], peers: [healthy] });
    vi.advanceTimersByTime(3 * MIN);
    await succeed(healthy.id, "m1");
    beforeNextWrite(() => takePeerAway(healthy));
    await failOnce(dead.id, "m1");
    expect(demotion(await load(dead.id))).toBeNull();
  });

  it.each([
    ["is turned off", (healthy) => takePeerAway(healthy)],
    ["is rate limited on that model", (healthy) => auth.markAccountUnavailable(
      healthy.id, 429, "Too many requests", provider, "m1", Date.now() + 30 * MIN,
    )],
  ])("tries the demoted key once its cooldown ends when the only other key %s, and a success lifts the demotion", async (_label, takeAway) => {
    const { dead, healthy } = await demotedKey();
    await takeAway(healthy);
    const waiting = await auth.getProviderCredentials(provider, null, "m1");
    expect(waiting.allRateLimited).toBe(true);
    expect((new Date(waiting.retryAfter).getTime() - Date.now()) / MIN).toBe(2);
    vi.advanceTimersByTime(2 * MIN);
    const probe = await auth.getProviderCredentials(provider, null, "m1");
    expect(probe.connectionId).toBe(dead.id);
    await auth.clearAccountError(dead.id, probe, "m1");
    expect(demotion(await load(dead.id))).toBeNull();
  });

  it("does not let a demotion on one model carry a stale streak into refusals on another 20 hours later", async () => {
    const { dead, healthy } = await demotedKey();
    vi.advanceTimersByTime(20 * 60 * MIN);
    await fail(dead.id, { times: 2, models: ["m2"], peers: [healthy] });
    expect(await load(dead.id)).toMatchObject({ isActive: true, authFailCount: 2, authFailModels: ["m2"] });
  });

  it("does not let a demotion bridge a gap past an hour after the streak's last refusal", async () => {
    const { dead, healthy } = await demotedKey();
    expect(demotedMin(await refuseAfterDemotion(dead, healthy))).toBe(120);
    vi.advanceTimersByTime(90 * MIN);
    await fail(dead.id, { times: 1, models: ["m2"], peers: [healthy] });
    expect(await load(dead.id)).toMatchObject({ authFailCount: 1, authFailModels: ["m2"] });
  });

  it("does not let a demotion on one model bridge a gap in a later streak on others", async () => {
    const { dead, healthy } = await demotedKey();
    await succeed(dead.id, "m2");
    await fail(dead.id, { times: 3, models: ["m2"], peers: [healthy] });
    vi.advanceTimersByTime(40 * MIN);
    await fail(dead.id, { times: 2, models: ["m3"], peers: [healthy] });
    expect(await load(dead.id)).toMatchObject({ isActive: true, authFailCount: 2, authFailModels: ["m3"] });
  });

  it("does not let a demotion raised before the streak began bridge its gaps", async () => {
    const { dead, healthy } = await demotedKey();
    await succeed(dead.id, "m2");
    vi.advanceTimersByTime(5 * MIN);
    await fail(dead.id, { times: 1, models: ["m1"], peers: [healthy] });
    vi.advanceTimersByTime(25 * MIN);
    await fail(dead.id, { times: 1, models: ["m2"], peers: [healthy] });
    expect(await load(dead.id)).toMatchObject({ authFailCount: 1, authFailModels: ["m2"] });
  });

  it("doubles a demotion after a refusal on another model started the streak over", async () => {
    const { dead, healthy } = await demotedKey();
    vi.setSystemTime(new Date(demotion(await load(dead.id)).until).getTime() + 15 * MIN);
    await fail(dead.id, { times: 1, models: ["m2"], peers: [healthy] });
    expect(await load(dead.id)).toMatchObject({ authFailCount: 1, authFailModels: ["m2"] });
    vi.advanceTimersByTime(MIN);
    await fail(dead.id, { times: 1, models: ["m1"], peers: [healthy] });
    const conn = await load(dead.id);
    expect(conn).toMatchObject({ isActive: true, authFailModels: ["m2", "m1"] });
    expect(demotedMin(conn)).toBe(120);
  });

  it("keeps only the run since a gap a one-model streak outlived when another model joins", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 2, models: ["m1"], peers: [healthy] });
    vi.advanceTimersByTime(50 * MIN);
    await fail(dead.id, { times: 2, models: ["m1"], peers: [healthy] });
    vi.advanceTimersByTime(3 * MIN);
    await fail(dead.id, { times: 1, models: ["m2"], peers: [healthy] });
    expect(await load(dead.id)).toMatchObject({ isActive: true, authFailCount: 3, authFailBursts: 1, authFailModels: ["m1", "m2"] });
  });

  it.each([
    ["403s on m1, then a 403 on m2 30 minutes later", 403, DEAD_403, "m2", 30, 1],
    ["401s on m1, then a 401 on m1 15 minutes later", 401, "Invalid API key", "m1", 15, 1],
    ["403s on m1, then a 403 on m1 50 minutes later", 403, DEAD_403, "m1", 50, 5],
  ])("on the same upstream, %s, counts %i", async (_label, status, text, next, gapMin, count) => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 4, models: ["m1"], peers: [healthy], status, text, stepMs: 2 * MIN });
    vi.advanceTimersByTime(gapMin * MIN);
    await fail(dead.id, { times: 1, models: [next], peers: [healthy], status, text });
    expect(await load(dead.id)).toMatchObject({ isActive: true, authFailCount: count });
  });

  // A key refused with 403s on one model, then revoked: its 401s start a clean
  // all-401 streak, which turns it off.
  it("turns a key off that gets 401s on m1 after three 403s and a 15-minute pause", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 3, models: ["m1"], peers: [healthy] });
    vi.advanceTimersByTime(15 * MIN);
    expect(await failUntilOff(dead.id, healthy, revoked)).toBe(12);
    expect((await load(dead.id)).autoDisabledReason).toBe('401 "Invalid API key" on m1');
  });

  it("turns a key off whose fifth failure on m1 is the first 401", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 4, models: ["m1"], peers: [healthy] });
    vi.advanceTimersByTime(3 * MIN);
    expect(await failUntilOff(dead.id, healthy, revoked)).toBe(12);
  });

  it("turns a demoted key off once it gets 401s on that model, after a 403 while demoted", async () => {
    const { dead, healthy } = await demotedKey();
    vi.advanceTimersByTime(30 * MIN);
    await fail(dead.id, { times: 1, models: ["m1"], peers: [healthy] });
    vi.advanceTimersByTime(2 * MIN);
    expect(await failUntilOff(dead.id, healthy, { ...revoked, stepMs: 2 * MIN })).toBe(10);
    expect(demotion(await load(dead.id)).level).toBe(1);
  });

  // Each round is 4 refusals over 10.5 minutes, one short of a demotion, then a success.
  it.each([
    ["never demotes a working key that one model refuses 4 times running", true, []],
    ["demotes the same key once the 5th refusal comes before a success", false, [1]],
  ])("%s", async (_label, succeeds, levels) => {
    const key = await addKey("a");
    const healthy = await addKey("b");
    const seen = [];
    const check = async () => {
      const level = demotion(await load(key.id))?.level;
      if (level && !seen.includes(level)) seen.push(level);
    };
    for (let round = 0; round < (succeeds ? 16 : 1); round++) {
      await fail(key.id, { times: 4, models: ["m1"], peers: [healthy], stepMs: 3.5 * MIN });
      await check();
      vi.advanceTimersByTime(3.5 * MIN);
      if (succeeds) await succeed(key.id, "m1");
      else await fail(key.id, { times: 1, models: ["m1"], peers: [healthy] });
      await check();
      vi.advanceTimersByTime(MIN);
    }
    expect(seen).toEqual(levels);
    expect((await load(key.id)).isActive).toBe(true);
  });

  it.each([
    ["403s on two models", ["m1", "m2"], 403, DEAD_403],
    ["401s on one model", ["m1"], 401, "Invalid API key"],
  ])("still turns the key off, without demoting it, for %s", async (_label, models, status, text) => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 5, models, peers: [healthy], status, text });
    const conn = await load(dead.id);
    expect(conn.isActive).toBe(false);
    expect(demotion(conn)).toBeNull();
  });

  it("writes the demotion message once, and lets a later error replace it", async () => {
    const { dead } = await demotedKey();
    expect((await load(dead.id)).lastError).toBe(MESSAGE);
    vi.advanceTimersByTime(MIN);
    await failOnce(dead.id, "m2", 429, "Too many requests");
    expect(await load(dead.id)).toMatchObject({ lastError: "Too many requests", authDemote_m1: { level: 1 } });
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

  it("keeps a key on whose proxy is refused while a direct key serves, even for over an hour", async () => {
    const proxied = await addKey("a", viaProxy("http://proxy-x.test:8080"));
    const direct = await addKey("b");
    await fail(proxied.id, { times: 22, models: ["m1", "m2"], peers: [direct] });
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

  it.each([
    ["an OAuth account", { authType: "oauth", accessToken: "test-access-token" }],
    ["a session cookie", { authType: "cookie" }],
  ])("keeps %s on whose expired token keeps failing while its peer serves", async (_label, auth) => {
    const expired = await addKey("a", auth);
    const healthy = await addKey("b");
    await fail(expired.id, { times: 8, models: ["m1"], peers: [healthy], status: 401, text: "OAuth token has expired." });
    const conn = await load(expired.id);
    expect(conn.isActive).toBe(true);
    expect(conn).not.toHaveProperty("authFailCount");
  });

  it.each([
    ["azureEndpoint", "https://a.openai.azure.test", "https://b.openai.azure.test"],
    ["region", "eu-west-1", "us-east-1"],
    ["location", "europe-west4", "us-central1"],
    ["accountId", "acct-a", "acct-b"],
    ["projectId", "proj-a", "proj-b"],
  ])("needs an hour, not 10 minutes, to trip a key while only a key with a different %s serves", async (field, ownValue, peerValue) => {
    const psd = (value) => ({ providerSpecificData: { baseUrl: "https://dead-keys.test/v1", [field]: value } });
    const a = await addKey("a", psd(ownValue));
    const b = await addKey("b", psd(peerValue));
    await fail(a.id, { times: 8, models: ["m1"], peers: [b], status: 401, text: "Invalid API key" });
    expect(await load(a.id)).toMatchObject({ isActive: true, authFailCount: 8, authFailSameUpstream: false });

    vi.advanceTimersByTime(3 * MIN);
    await fail(a.id, { times: 14, models: ["m1"], peers: [b], status: 401, text: "Invalid API key" });
    expect((await load(a.id)).isActive).toBe(false);
  });

  it("trips a key whose azureEndpoint matches its peer's", async () => {
    const psd = { providerSpecificData: { azureEndpoint: "https://a.openai.azure.test/" } };
    const dead = await addKey("a", psd);
    const healthy = await addKey("b", { providerSpecificData: { azureEndpoint: "https://a.openai.azure.test" } });
    await fail(dead.id, { times: 6, models: ["m1"], peers: [healthy], status: 401, text: "Invalid API key" });
    expect((await load(dead.id)).isActive).toBe(false);
  });

  // Its own server may be the one refusing, so it gets an hour, not 10 minutes.
  it("keeps a key on its own base URL on through 30 minutes of refusals while a node-URL key serves, then trips", async () => {
    const own = await addKey("a", { providerSpecificData: { baseUrl: "https://own.dead-keys.test/v1", ownBaseUrl: true } });
    const node = await addKey("b");
    await fail(own.id, { times: 11, models: ["m1", "m2"], peers: [node] });
    expect((await load(own.id)).isActive).toBe(true);

    vi.advanceTimersByTime(3 * MIN);
    await fail(own.id, { times: 10, models: ["m1", "m2"], peers: [node] });
    expect((await load(own.id)).isActive).toBe(false);
  });

  it("trips a key on the same base URL as its peer, ignoring a trailing slash", async () => {
    const dead = await addKey("a", { providerSpecificData: { baseUrl: "https://dead-keys.test/v1/" } });
    const healthy = await addKey("b");
    await fail(dead.id, { times: 6, models: ["m1"], peers: [healthy], status: 401, text: "Invalid API key" });
    expect((await load(dead.id)).isActive).toBe(false);
  });

  // The provider refuses some requests on every key: B is refused on a model
  // and then gets one through before A tries it again.
  it("disables neither key when the provider refuses a share of every key's requests", async () => {
    const a = await addKey("a");
    const b = await addKey("b");
    for (const m of ["m1", "m2"]) await succeed(b.id, m);
    for (let i = 0; i < 12; i++) {
      const model = i % 2 ? "m2" : "m1";
      await failOnce(a.id, model);
      vi.advanceTimersByTime(30 * 1000);
      await failOnce(b.id, model);
      vi.advanceTimersByTime(30 * 1000);
      await succeed(b.id, model);
      vi.advanceTimersByTime(MIN);
    }
    for (const k of [a, b]) expect((await load(k.id)).isActive).toBe(true);
  });

  it("does not count a first refusal when the peer was also refused on that model within 10 minutes", async () => {
    const a = await addKey("a");
    const b = await addKey("b");
    await failOnce(b.id, "m1");
    vi.advanceTimersByTime(MIN);
    await succeed(b.id, "m1");
    await failOnce(a.id, "m1");
    expect(await load(a.id)).not.toHaveProperty("authFailCount");
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

// The live case: two keys of one custom endpoint on different Snowflake
// accounts, each with its own base URL, behind the same proxy settings.
describe("keys of one endpoint on different upstreams", () => {
  const snowflake = (host, extra = {}) => ({
    providerSpecificData: {
      baseUrl: `https://${host}.snowflakecomputing.test/api/v2/cortex/v1`, connectionProxyEnabled: false, ...extra,
    },
  });
  const models = ["claude-opus-5-5", "kimi-k3"];

  it("turns off the dead key after an hour of 403s, not at 15 minutes", async () => {
    const dead = await addKey("a", snowflake("acct-dead", { ownBaseUrl: true }));
    const healthy = await addKey("b", snowflake("acct-live"));
    await fail(dead.id, { times: 7, models, peers: [healthy], stepMs: 2.5 * MIN });
    expect(await load(dead.id)).toMatchObject({ isActive: true, authFailCount: 7, authFailSameUpstream: false });

    vi.advanceTimersByTime(2.5 * MIN);
    await fail(dead.id, { times: 17, models, peers: [healthy], stepMs: 2.5 * MIN });
    expect((await load(dead.id)).isActive).toBe(true);

    vi.advanceTimersByTime(2.5 * MIN);
    await fail(dead.id, { times: 1, models, peers: [healthy] });
    const conn = await load(dead.id);
    expect(conn.isActive).toBe(false);
    expect(conn.autoDisabledReason).toBe('403 "Not authorized for this endpoint" on claude-opus-5-5, kimi-k3');
  });

  it("turns off the dead key within 10-12 minutes when its peer is on the same base URL", async () => {
    const dead = await addKey("a", snowflake("acct-shared"));
    const healthy = await addKey("b", snowflake("acct-shared"));
    await fail(dead.id, { times: 4, models, peers: [healthy], stepMs: 2.5 * MIN });
    expect((await load(dead.id)).isActive).toBe(true);
    vi.advanceTimersByTime(2.5 * MIN);
    await fail(dead.id, { times: 1, models, peers: [healthy] });
    expect(await load(dead.id)).toMatchObject({ isActive: false, authFailSameUpstream: true });
  });

  it("needs the hour once any counted failure had only a peer on another upstream", async () => {
    const dead = await addKey("a", snowflake("acct-dead", { ownBaseUrl: true }));
    const other = await addKey("b", snowflake("acct-live"));
    const same = await addKey("c", snowflake("acct-dead"));
    await fail(dead.id, { times: 1, models, peers: [other] });
    vi.advanceTimersByTime(3 * MIN);
    await fail(dead.id, { times: 6, models, peers: [other, same] });
    expect(await load(dead.id)).toMatchObject({ isActive: true, authFailCount: 7, authFailSameUpstream: false });
  });

  // One request as the router serves it: fill-first picks the first key whose
  // model lock has run out, and a refused key falls back to the next one.
  async function route(model, deadIds) {
    const tried = new Set();
    for (;;) {
      const creds = await auth.getProviderCredentials(provider, tried, model);
      if (!creds?.connectionId) return null;
      if (!deadIds.includes(creds.connectionId)) {
        await auth.clearAccountError(creds.connectionId, creds, model);
        return creds.connectionId;
      }
      await failOnce(creds.connectionId, model);
      tried.add(creds.connectionId);
    }
  }

  // By default, requests every minute while someone works and none while
  // they're away; modelAt(minute, requestsSoFar) can pick any other pattern.
  // Returns the minutes from the dead key's first failure until it turned off.
  async function drive(dead, { workMin, idleMin, totalMin, onMinute, modelAt }) {
    modelAt ??= (minute, i) => (minute % (workMin + idleMin) < workMin ? models[i % 2] : null);
    let firstFailAt = null;
    let requests = 0;
    for (let minute = 0; minute < totalMin; minute++) {
      if (minute > 0) vi.advanceTimersByTime(MIN);
      await onMinute?.(minute);
      const model = modelAt(minute, requests);
      if (!model) continue;
      requests++;
      await route(model, [dead.id]);
      const conn = await load(dead.id);
      firstFailAt ??= conn.lastErrorAt ? Date.now() : null;
      if (!conn.isActive) return (Date.now() - firstFailAt) / MIN;
    }
    return null;
  }

  it.each([
    [25, 15],
    [25, 20],
    [45, 11],
    [45, 15],
  ])("turns off the dead key within 60-90 minutes when someone works %i minutes and pauses %i", async (workMin, idleMin) => {
    const dead = await addKey("a", snowflake("acct-dead", { ownBaseUrl: true }));
    await addKey("b", snowflake("acct-live"));
    const minutes = await drive(dead, { workMin, idleMin, totalMin: 6 * 60 });
    expect(minutes).toBeGreaterThanOrEqual(60);
    expect(minutes).toBeLessThanOrEqual(90);
  });

  // Requests as the router serves them, minute by minute; `refuses(model)` says
  // whether the dead key is refused on it. Returns the minutes the dead key was
  // tried and refused, the demotions it got as [minute, hours], and who served.
  async function watch(dead, { modelAt, totalMin, refuses = () => true }) {
    const refusals = [];
    const locks = [];
    const served = [];
    for (let minute = 0; minute < totalMin; minute++) {
      if (minute > 0) vi.advanceTimersByTime(MIN);
      const model = modelAt(minute);
      if (!model) continue;
      const before = await load(dead.id);
      served.push([model, await route(model, refuses(model) ? [dead.id] : [])]);
      const conn = await load(dead.id);
      expect(conn.isActive).toBe(true);
      if (!conn.lastErrorAt || conn.lastErrorAt === before.lastErrorAt) continue;
      refusals.push(minute);
      const demotion = conn[`authDemote_${model}`];
      if (demotion && demotion.until !== before[`authDemote_${model}`]?.until) {
        locks.push([minute, (new Date(demotion.until).getTime() - Date.now()) / MIN / 60]);
      }
    }
    return { refusals, locks, served };
  }

  const opusOnly = (workMin, idleMin) => (minute) => (minute % (workMin + idleMin) < workMin ? "claude-opus-5-5" : null);

  // The live case of 2026-10-28: only claude-opus-5-5 in use, someone working
  // 10 minutes and pausing 13, the dead key and its peer on different accounts.
  it("demotes a dead key refused on the only model in use within 60-75 minutes, then tries it about once per demotion", async () => {
    const dead = await addKey("a", snowflake("acct-dead", { ownBaseUrl: true }));
    const healthy = await addKey("b", snowflake("acct-live"));
    const { refusals, locks } = await watch(dead, { modelAt: opusOnly(10, 13), totalMin: 12 * 60 });
    const [firstLockAt] = locks[0];
    expect(firstLockAt - refusals[0]).toBeGreaterThanOrEqual(60);
    expect(firstLockAt - refusals[0]).toBeLessThanOrEqual(75);
    expect(locks.map(([, hours]) => hours)).toEqual([1, 2, 4, 8]);
    expect(refusals.filter((m) => m > firstLockAt)).toHaveLength(locks.length - 1);
    expect((await load(dead.id)).lastError).toBe('claude-opus-5-5 demoted for 8h after repeated 403 "Not authorized for this endpoint"');
    expect((await load(healthy.id)).isActive).toBe(true);
  }, 60000);

  it("demotes it within 25-30 minutes when the peer is on the same account", async () => {
    const dead = await addKey("a", snowflake("acct-shared"));
    await addKey("b", snowflake("acct-shared"));
    const { refusals, locks } = await watch(dead, { modelAt: opusOnly(10, 13), totalMin: 12 * 60 });
    const [firstLockAt] = locks[0];
    expect(firstLockAt - refusals[0]).toBeGreaterThanOrEqual(25);
    expect(firstLockAt - refusals[0]).toBeLessThanOrEqual(30);
    expect(locks.map(([, hours]) => hours)).toEqual([1, 2, 4, 8]);
  }, 60000);

  it("keeps serving kimi-k3 on a key that lacks claude-opus-5-5, doubling its opus demotion, and never turns it off", async () => {
    const partial = await addKey("a", snowflake("acct-shared"));
    await addKey("b", snowflake("acct-shared"));
    const modelAt = (minute) => (minute % 20 === 19 ? "kimi-k3" : "claude-opus-5-5");
    const { refusals, locks, served } = await watch(partial, {
      modelAt, totalMin: 8 * 60, refuses: (model) => model === "claude-opus-5-5",
    });
    expect(served.filter(([model]) => model === "kimi-k3").every(([, id]) => id === partial.id)).toBe(true);
    expect(locks.map(([, hours]) => hours)).toEqual([1, 2, 4, 8]);
    expect(refusals.filter((m) => m > locks[0][0])).toHaveLength(3);
  }, 60000);

  it("still turns off the dead key within 60-90 minutes when the router restarts mid-streak under light traffic", async () => {
    const dead = await addKey("a", snowflake("acct-dead", { ownBaseUrl: true }));
    await addKey("b", snowflake("acct-live"));
    const restart = (minute) => {
      if (minute !== 30) return;
      global._authEvents.success.clear();
      global._authEvents.refused.clear();
    };
    // One request every 6 minutes.
    const minutes = await drive(dead, { workMin: 1, idleMin: 5, totalMin: 3 * 60, onMinute: restart });
    expect(minutes).toBeGreaterThanOrEqual(60);
    expect(minutes).toBeLessThanOrEqual(90);
  });

  // Light steady traffic: a request every minMin-maxMin minutes, on a model
  // picked at random, from a seeded generator so every run is the same.
  function steadyTraffic(seed, minMin, maxMin) {
    let state = seed;
    const random = () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const at = new Map();
    for (let minute = 0; minute < 24 * 60; minute += minMin + Math.floor(random() * (maxMin - minMin + 1))) {
      at.set(minute, models[random() < 0.5 ? 0 : 1]);
    }
    return (minute) => at.get(minute) ?? null;
  }

  async function tripMinutesBySeed(minMin, maxMin, totalMin) {
    const bySeed = {};
    for (let seed = 1; seed <= 40; seed++) {
      provider = `${PROVIDER}-${++seq}`;
      const dead = await addKey("a", snowflake("acct-dead", { ownBaseUrl: true }));
      await addKey("b", snowflake("acct-live"));
      bySeed[seed] = await drive(dead, { totalMin, modelAt: steadyTraffic(seed, minMin, maxMin) });
    }
    return bySeed;
  }

  it.each([
    [3, 8, 90],
    [8, 10, 150],
  ])("turns off the dead key under light steady traffic, a request every %i-%i minutes, within %i minutes", async (minMin, maxMin, limitMin) => {
    const bySeed = await tripMinutesBySeed(minMin, maxMin, limitMin + 1);
    const late = Object.entries(bySeed).filter(([, minutes]) => minutes === null || minutes > limitMin);
    expect(late).toEqual([]);
  }, 120000);

  // The first session leaves one counted failure: under fill-first a model's
  // first refusal comes before its peer serves it, so only the retry counts.
  it("turns off the dead key when a lone early failure is followed by a pause and then steady work", async () => {
    const dead = await addKey("a", snowflake("acct-dead", { ownBaseUrl: true }));
    await addKey("b", snowflake("acct-live"));
    const modelAt = (minute, i) => (minute < 3 || minute >= 18 ? models[i % 2] : null);
    const minutes = await drive(dead, { totalMin: 3 * 60, modelAt });
    expect(minutes).toBeGreaterThanOrEqual(60);
    expect(minutes).toBeLessThanOrEqual(90);
  }, 60000);

  it("keeps the streak through a 15-minute idle gap, but starts over after a gap of more than an hour", async () => {
    const dead = await addKey("a", snowflake("acct-dead", { ownBaseUrl: true }));
    const healthy = await addKey("b", snowflake("acct-live"));
    await fail(dead.id, { times: 4, models, peers: [healthy] });
    const firstAt = (await load(dead.id)).authFailFirstAt;
    vi.advanceTimersByTime(15 * MIN);
    await fail(dead.id, { times: 1, models, peers: [healthy] });
    expect(await load(dead.id)).toMatchObject({ authFailCount: 5, authFailFirstAt: firstAt, authFailBursts: 1 });

    vi.advanceTimersByTime(61 * MIN);
    await fail(dead.id, { times: 1, models, peers: [healthy] });
    expect(await load(dead.id)).toMatchObject({ isActive: true, authFailCount: 1, authFailFirstAt: new Date().toISOString() });
  });

  it("takes the full hour for a streak saved before runs had a start", async () => {
    const dead = await addKey("a", snowflake("acct-dead", { ownBaseUrl: true }));
    const healthy = await addKey("b", snowflake("acct-live"));
    // A lone refusal 36 minutes ago, then a run of 3 ending 6 minutes ago.
    await db.updateProviderConnection(dead.id, {
      authFailCount: 4, authFailRunCount: 3, authFailBursts: 1, authFailModels: models,
      authFailAll401: false, authFailSameUpstream: false,
      authFailFirstAt: new Date(Date.now() - 36 * MIN).toISOString(),
      authFailLastAt: new Date(Date.now() - 6 * MIN).toISOString(),
    });
    await fail(dead.id, { times: 10, models, peers: [healthy], stepMs: 3 * MIN });
    expect((await load(dead.id)).isActive).toBe(true);
    vi.advanceTimersByTime(3 * MIN);
    await fail(dead.id, { times: 11, models, peers: [healthy], stepMs: 3 * MIN });
    expect((await load(dead.id)).isActive).toBe(false);
  });

  it("never trips on single refusals spread thinly over more than an hour", async () => {
    const dead = await addKey("a", snowflake("acct-dead", { ownBaseUrl: true }));
    const healthy = await addKey("b", snowflake("acct-live"));
    await fail(dead.id, { times: 8, models, peers: [healthy], stepMs: 15 * MIN });
    expect(await load(dead.id)).toMatchObject({ isActive: true, authFailCount: 8, authFailBursts: 0 });
  });

  it("never trips on one burst followed by single refusals spread over more than an hour", async () => {
    const dead = await addKey("a", snowflake("acct-dead", { ownBaseUrl: true }));
    const healthy = await addKey("b", snowflake("acct-live"));
    await fail(dead.id, { times: 2, models, peers: [healthy], stepMs: 2.5 * MIN });
    vi.advanceTimersByTime(17.5 * MIN);
    await fail(dead.id, { times: 5, models, peers: [healthy], stepMs: 15 * MIN });
    expect(await load(dead.id)).toMatchObject({ isActive: true, authFailCount: 7, authFailBursts: 1 });
  });

  it("never trips on single refusals followed by one short burst, however long ago the first was", async () => {
    const dead = await addKey("a", snowflake("acct-dead", { ownBaseUrl: true }));
    const healthy = await addKey("b", snowflake("acct-live"));
    await fail(dead.id, { times: 4, models, peers: [healthy], stepMs: 15 * MIN });
    vi.advanceTimersByTime(12 * MIN);
    await fail(dead.id, { times: 5, models, peers: [healthy], stepMs: 2.5 * MIN });
    expect(await load(dead.id)).toMatchObject({ isActive: true, authFailCount: 9, authFailRunCount: 5, authFailBursts: 1 });
  });

  it("trips over an hour once the refusals include 2 bursts", async () => {
    const dead = await addKey("a", snowflake("acct-dead", { ownBaseUrl: true }));
    const healthy = await addKey("b", snowflake("acct-live"));
    await fail(dead.id, { times: 2, models, peers: [healthy], stepMs: 2.5 * MIN });
    vi.advanceTimersByTime(17.5 * MIN);
    await fail(dead.id, { times: 2, models, peers: [healthy], stepMs: 20 * MIN });
    vi.advanceTimersByTime(18 * MIN);
    await fail(dead.id, { times: 1, models, peers: [healthy] });
    expect(await load(dead.id)).toMatchObject({ isActive: true, authFailBursts: 1 });
    vi.advanceTimersByTime(2.5 * MIN);
    await fail(dead.id, { times: 1, models, peers: [healthy] });
    expect(await load(dead.id)).toMatchObject({ isActive: false, authFailBursts: 2 });
  });

  it("never counts a peer behind a different proxy, even after an hour", async () => {
    const dead = await addKey("a", snowflake("acct-dead", { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy-x.test:8080" }));
    const healthy = await addKey("b", snowflake("acct-live", { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy-y.test:8080" }));
    await fail(dead.id, { times: 30, models, peers: [healthy], stepMs: 2.5 * MIN });
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

  it("stays off when a blank key is saved", async () => {
    const dead = await deadKey();
    await db.updateProviderConnection(dead.id, editBody("   "));
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

  it("re-enables when the key is re-added through the API with overwrite allowed", async () => {
    const dead = await deadKey();
    await db.createProviderConnection({ provider, authType: "apikey", name: "a", apiKey: "sk-test-new-0123456789" });
    await expectBackOn(dead.id);
  });

  it("stays off when the dashboard adds a key with the same name, which it refuses", async () => {
    const dead = await deadKey();
    await expect(db.createProviderConnection({
      provider, authType: "apikey", name: "a", apiKey: "sk-test-new-0123456789", allowOverwrite: false,
    })).rejects.toMatchObject({ code: "PROVIDER_NAME_CONFLICT" });
    expect((await load(dead.id)).isActive).toBe(false);
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

  it("is skipped by the custom endpoint page's Test all, like a key the user turned off", async () => {
    const dead = await deadKey();
    const manual = await addKey("c", { isActive: false });
    const all = await db.getProviderConnections({ provider });
    const tested = connectionsToTest(all).map((c) => c.id);
    expect(tested).not.toContain(dead.id);
    expect(tested).not.toContain(manual.id);
    expect(tested).toHaveLength(all.length - 2);
  });

  it("shows no automatic label, on the server or in the dashboard, once toggled on and off by hand", async () => {
    const dead = await deadKey();
    let local = await load(dead.id);
    for (const isActive of [true, false]) {
      const saved = await db.updateProviderConnection(dead.id, { isActive });
      local = withToggledActive(local, isActive, saved);
    }
    const label = (c) => c.isActive === false && Boolean(c.autoDisabledAt);
    expect(label(await load(dead.id))).toBe(false);
    expect(label(local)).toBe(false);
    expect(local.autoDisabledReason).toBeNull();
  });

  it("shows the label in the dashboard when a row still showing on is toggled off", async () => {
    const dead = await deadKey();
    const stale = { ...(await load(dead.id)), isActive: true, autoDisabledAt: null, autoDisabledReason: null };
    const res = await putConnection(
      new Request(`http://localhost/api/providers/${dead.id}`, { method: "PUT", body: JSON.stringify({ isActive: false }) }),
      { params: Promise.resolve({ id: dead.id }) },
    );
    const local = withToggledActive(stale, false, (await res.json()).connection);
    expect(local.autoDisabledReason).toBe((await load(dead.id)).autoDisabledReason);
    expect(local.autoDisabledAt).toBeTruthy();
  });

  it("keeps its reason when the whole provider is turned off", async () => {
    const dead = await deadKey();
    const { autoDisabledAt, autoDisabledReason } = await load(dead.id);
    await db.updateProviderConnection(dead.id, { isActive: false });
    expect(await load(dead.id)).toMatchObject({ isActive: false, autoDisabledAt, autoDisabledReason });
  });

  it("becomes a manual disable when the user turns it off after turning it back on", async () => {
    const dead = await deadKey();
    await db.updateProviderConnection(dead.id, { isActive: true });
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
