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
  const record = (conn, model = "m1") => conn[`authDemote_${model}`] ?? null;
  const demoted = (conn, model = "m1") => !!record(conn, model)?.demotedAt;
  const pick = async (model) => (await auth.getProviderCredentials(provider, null, model))?.connectionId;
  const takePeerAway = (healthy) => db.updateProviderConnection(healthy.id, { isActive: false });
  const atProbe = async (id, model = "m1") => vi.setSystemTime(new Date(record(await load(id), model).nextProbeAt));
  const MESSAGE = 'm1 demoted after repeated 403 "Not authorized for this endpoint"';

  async function demotedKey(model = "m1") {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 5, models: [model], peers: [healthy] });
    expect(demoted(await load(dead.id), model)).toBe(true);
    return { dead, healthy };
  }

  // [minute, same upstream, minute of the last refusal on another model]
  const R = (minute, sameUpstream = true, otherAt = null) => [minute, sameUpstream, otherAt];
  const T0 = Date.parse("2026-10-23T00:00:00.000Z");
  const at = (minute) => T0 + minute * MIN;
  it.each([
    ["4 refusals over 12 minutes", [R(0), R(4), R(8), R(12)], 4, false],
    ["5 refusals over 9 minutes", [R(0), R(2), R(4), R(6), R(9)], 5, false],
    ["5 refusals over 10 minutes", [R(0), R(2), R(4), R(6), R(10)], 5, true],
    ["5 over 59 minutes, one cross-upstream", [R(0), R(15, false), R(30), R(45), R(59)], 5, false],
    ["5 over 60 minutes, one cross-upstream", [R(0), R(15, false), R(30), R(45), R(60)], 5, true],
    ["a 60-minute gap", [R(0), R(2), R(4), R(64), R(66)], 5, true],
    ["a gap of 60 minutes and 1 ms", [R(0), R(2), R(4), R(6), R(66 + 1 / 60000)], 1, false],
    ["0, 2, 4, 6, then 67 to 71", [R(0), R(2), R(4), R(6), R(67), R(68), R(69), R(70), R(71)], 5, false],
    ["a refusal dated before the last one", [R(0), R(2), R(4), R(10), R(6)], 1, false],
    ["5 over 10 minutes, another model refused at minute 5", [R(0), R(2), R(4), R(6), R(10, true, 5)], 5, false],
    ["5 over 12 minutes, another model refused at minute 1", [R(0), R(2), R(4), R(6), R(12, true, 1)], 5, true],
    ["5 over 12 minutes, another model refused at minute 2", [R(0), R(2), R(4), R(6), R(12, true, 2)], 5, false],
    ["5 over 60 minutes cross-upstream, another refused at minute 2", [R(0, false), R(15), R(30), R(45), R(60, true, 2)], 5, false],
    ["5 over 62 minutes cross-upstream, another refused at minute 1", [R(0, false), R(15), R(30), R(45), R(62, true, 1)], 5, true],
  ])("counts %s as %i, demoting: %s", (_label, steps, count, isDemoted) => {
    let rec = null;
    for (const [minute, sameUpstream, otherAt] of steps) {
      rec = auth.__test__.nextDemoteRecord(rec, at(minute), {
        sameUpstream, otherRefusalAt: otherAt === null ? -Infinity : at(otherAt), reason: "403",
      });
    }
    expect(rec.count).toBe(count);
    expect(!!rec.demotedAt).toBe(isDemoted);
  });

  it("moves a demoted record's next probe out on each refusal, up to 180 minutes", () => {
    let rec = null;
    for (const minute of [0, 3, 6, 9, 12]) rec = auth.__test__.nextDemoteRecord(rec, at(minute), { sameUpstream: true, reason: "403" });
    expect(rec).toMatchObject({ demotedAt: new Date(at(12)).toISOString(), probeLevel: 0, nextProbeAt: new Date(at(22)).toISOString() });
    const waits = [];
    let minute = 12;
    for (let i = 0; i < 6; i++) {
      minute = (new Date(rec.nextProbeAt).getTime() - T0) / MIN;
      rec = auth.__test__.nextDemoteRecord(rec, at(minute), { sameUpstream: false, otherRefusalAt: at(minute), reason: "x" });
      waits.push((new Date(rec.nextProbeAt).getTime() - at(minute)) / MIN);
    }
    expect(waits).toEqual([20, 40, 90, 180, 180, 180]);
    expect(rec).toMatchObject({ count: 11, reason: "403", demotedAt: new Date(at(12)).toISOString() });
  });

  it("keeps a count's model-scoped mark until it starts over", () => {
    let rec = auth.__test__.nextDemoteRecord(null, at(0), { sameUpstream: true, modelScoped: true, reason: "403" });
    rec = auth.__test__.nextDemoteRecord(rec, at(2), { sameUpstream: true, reason: "403" });
    expect(rec.modelScoped).toBe(true);
    rec = auth.__test__.nextDemoteRecord(rec, at(70), { sameUpstream: true, reason: "403" });
    expect(rec.modelScoped).toBe(false);
  });

  it("demotes the key on that model, keeps it on, and keeps it first for other models", async () => {
    const { warn } = await import("@/sse/utils/logger.js");
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 4, models: ["claude-opus-5-5"], peers: [healthy] });
    expect(demoted(await load(dead.id), "claude-opus-5-5")).toBe(false);
    vi.advanceTimersByTime(3 * MIN);
    await fail(dead.id, { times: 1, models: ["claude-opus-5-5"], peers: [healthy] });

    const conn = await load(dead.id);
    expect(conn).toMatchObject({
      isActive: true,
      "authDemote_claude-opus-5-5": { count: 5, reason: '403 "Not authorized for this endpoint"' },
      lastError: 'claude-opus-5-5 demoted after repeated 403 "Not authorized for this endpoint"',
    });
    expect(conn).not.toHaveProperty("autoDisabledAt");
    expect(warn).toHaveBeenCalledWith("AUTH", "a demoted on claude-opus-5-5 after repeated 403s");
    vi.advanceTimersByTime(3 * MIN);
    expect(await pick("kimi-k3")).toBe(dead.id);
    expect(await pick("claude-opus-5-5")).toBe(healthy.id);
  });

  it("keeps counting toward a demotion through successes on other models", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 3, models: ["m1"], peers: [healthy] });
    await succeed(dead.id, "m2");
    vi.advanceTimersByTime(3 * MIN);
    await fail(dead.id, { times: 2, models: ["m1"], peers: [healthy] });
    expect(record(await load(dead.id))).toMatchObject({ count: 5, demotedAt: expect.any(String) });
  });

  it("starts the count over on a success on that model", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 4, models: ["m1"], peers: [healthy] });
    await succeed(dead.id, "m1");
    expect(record(await load(dead.id))).toBeNull();
    vi.advanceTimersByTime(3 * MIN);
    await fail(dead.id, { times: 1, models: ["m1"], peers: [healthy] });
    expect(record(await load(dead.id))).toMatchObject({ count: 1 });
  });

  it("demotes on 403s with 401s in between, which neither count nor start it over", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    for (let i = 0; i < 10; i++) {
      if (i > 0) vi.advanceTimersByTime(2 * MIN);
      const revoked = i % 2 === 1;
      await fail(dead.id, { times: 1, models: ["m1"], peers: [healthy], ...(revoked ? { status: 401, text: "Invalid API key" } : {}) });
    }
    const conn = await load(dead.id);
    expect(conn.isActive).toBe(true);
    expect(record(conn)).toMatchObject({ count: 5, demotedAt: expect.any(String) });
  });

  it("does not demote, and still turns the key off, when it is refused on 2 models", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 5, models: ["m1", "m1", "m1", "m2", "m1"], peers: [healthy] });
    const conn = await load(dead.id);
    expect(conn.isActive).toBe(false);
    expect(demoted(conn)).toBe(false);
  });

  it("keeps a key on after 6 refusals on one model, 50 minutes idle and one 403 on another", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 6, models: ["m1"], peers: [healthy] });
    expect(demoted(await load(dead.id))).toBe(true);
    vi.advanceTimersByTime(50 * MIN);
    await fail(dead.id, { times: 1, models: ["m2"], peers: [healthy] });
    expect((await load(dead.id)).isActive).toBe(true);
  });

  it("probes the demoted key 10 minutes after demotion, then 20, 40, 90 and 180 minutes after each refused probe", async () => {
    const { dead, healthy } = await demotedKey();
    const waits = [(new Date(record(await load(dead.id)).nextProbeAt) - new Date(record(await load(dead.id)).demotedAt)) / MIN];
    for (let i = 0; i < 6; i++) {
      vi.setSystemTime(new Date(record(await load(dead.id)).nextProbeAt).getTime() - 1);
      expect(await pick("m1")).not.toBe(dead.id);
      vi.advanceTimersByTime(1);
      expect(await pick("m1")).toBe(dead.id);
      await succeed(healthy.id, "m1");
      await failOnce(dead.id, "m1");
      waits.push((new Date(record(await load(dead.id)).nextProbeAt).getTime() - Date.now()) / MIN);
    }
    expect(waits).toEqual([10, 20, 40, 90, 180, 180, 180]);
  });

  it.each([
    ["a 429", (dead) => failOnce(dead.id, "m1", 429, "Too many requests")],
    ["a 500", (dead) => failOnce(dead.id, "m1", 500, "Internal server error")],
    ["no answer at all", async () => {}],
  ])("takes the probe again 10 minutes later, at the same level, after %s", async (_label, answer) => {
    const { dead } = await demotedKey();
    await atProbe(dead.id);
    expect(await pick("m1")).toBe(dead.id);
    await answer(dead);
    expect(record(await load(dead.id))).toMatchObject({ probeLevel: 0 });
    vi.advanceTimersByTime(10 * MIN - 1);
    expect(await pick("m1")).not.toBe(dead.id);
    vi.advanceTimersByTime(1);
    expect(await pick("m1")).toBe(dead.id);
  });

  it("sends one probe per interval to a burst of requests", async () => {
    const { dead } = await demotedKey();
    await atProbe(dead.id);
    const picks = await Promise.all(Array.from({ length: 5 }, () => pick("m1")));
    expect(picks.filter((id) => id === dead.id)).toHaveLength(1);
  });

  it("does not take a probe another process took first", async () => {
    const { dead } = await demotedKey();
    await atProbe(dead.id);
    const taken = { ...record(await load(dead.id)), probeLevel: 1, nextProbeAt: new Date(Date.now() + 20 * MIN).toISOString() };
    beforeNextWrite(() => db.updateProviderConnection(dead.id, { authDemote_m1: taken }));
    expect(await pick("m1")).not.toBe(dead.id);
    expect(record(await load(dead.id))).toEqual(taken);
  });

  it("lifts the demotion when the probe succeeds, and keeps it, probing later, when it is refused", async () => {
    const { dead, healthy } = await demotedKey();
    await atProbe(dead.id);
    const refused = await auth.getProviderCredentials(provider, null, "m1");
    expect(refused.connectionId).toBe(dead.id);
    await succeed(healthy.id, "m1");
    await failOnce(dead.id, "m1");
    expect(record(await load(dead.id))).toMatchObject({ count: 6, probeLevel: 1 });

    await atProbe(dead.id);
    const probe = await auth.getProviderCredentials(provider, null, "m1");
    expect(probe.connectionId).toBe(dead.id);
    await auth.clearAccountError(dead.id, probe, "m1");
    expect(record(await load(dead.id))).toBeNull();
    expect(await pick("m1")).toBe(dead.id);
  });

  it("keeps the probe time and the lift through a restart", async () => {
    const { dead } = await demotedKey();
    const restart = () => {
      global._authEvents.success.clear();
      global._authEvents.refused.clear();
    };
    restart();
    vi.advanceTimersByTime(9 * MIN);
    expect(await pick("m1")).not.toBe(dead.id);
    vi.advanceTimersByTime(MIN);
    const probe = await auth.getProviderCredentials(provider, null, "m1");
    expect(probe.connectionId).toBe(dead.id);
    await auth.clearAccountError(dead.id, probe, "m1");
    restart();
    expect(record(await load(dead.id))).toBeNull();
    expect(await pick("m1")).toBe(dead.id);
  });

  it("does not demote, or log it, when a success on that model lands while the refusal is on its way", async () => {
    const { warn } = await import("@/sse/utils/logger.js");
    warn.mockClear();
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 4, models: ["m1"], peers: [healthy] });
    vi.advanceTimersByTime(3 * MIN);
    await succeed(healthy.id, "m1");
    beforeNextWrite(() => db.updateProviderConnection(dead.id, { authDemote_m1: null }));
    await failOnce(dead.id, "m1");
    expect(record(await load(dead.id))).toBeNull();
    expect(warn.mock.calls.filter(([, line]) => line.includes("demoted"))).toEqual([]);
  });

  it("lifts the demotion on a success on that model after another model's success cleared the key's errors", async () => {
    const { dead } = await demotedKey();
    vi.advanceTimersByTime(3 * MIN);
    await succeed(dead.id, "m2");
    const conn = await load(dead.id);
    expect(conn).toMatchObject({ lastError: null, testStatus: "active", authFailCount: null, modelLock_m1: null });
    await auth.clearAccountError(dead.id, conn, "m1");
    expect(record(await load(dead.id))).toBeNull();
  });

  it("lifts a demotion written while a success on that model, read before it, was on its way", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 4, models: ["m1"], peers: [healthy] });
    const before = await load(dead.id);
    vi.advanceTimersByTime(3 * MIN);
    beforeNextWrite(() => fail(dead.id, { times: 1, models: ["m1"], peers: [healthy] }));
    await auth.clearAccountError(dead.id, before, "m1");
    expect(record(await load(dead.id))).toBeNull();
  });

  it("does not count a refusal from a request sent with the key before a new one was pasted in", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 4, models: ["m1"], peers: [healthy] });
    const oldKey = (await load(dead.id)).apiKey;
    await db.updateProviderConnection(dead.id, { apiKey: "sk-test-new-0123456789" });
    vi.advanceTimersByTime(3 * MIN);
    await succeed(healthy.id, "m1");
    await auth.markAccountUnavailable(dead.id, 403, DEAD_403, provider, "m1", null, oldKey);
    expect(record(await load(dead.id))).toBeNull();
  });

  it.each([
    ["a new key is pasted in", (id) => db.updateProviderConnection(id, { apiKey: "sk-test-new-0123456789" })],
    ["the key is toggled off and on", async (id) => {
      await db.updateProviderConnection(id, { isActive: false });
      await db.updateProviderConnection(id, { isActive: true });
    }],
  ])("clears every demotion when %s", async (_label, change) => {
    const { dead, healthy } = await demotedKey();
    await fail(dead.id, { times: 2, models: ["m2"], peers: [healthy] });
    await change(dead.id);
    const conn = await load(dead.id);
    expect([record(conn), record(conn, "m2")]).toEqual([null, null]);
    vi.advanceTimersByTime(3 * MIN);
    expect(await pick("m1")).toBe(dead.id);
  });

  it("shows the demotion and its reason on the dashboard, and clears it from there", async () => {
    const { dead } = await demotedKey();
    const { GET, POST } = await import("@/app/api/models/availability/route.js");
    const whileLocked = (await (await GET()).json()).models.filter((m) => m.connectionId === dead.id);
    expect(whileLocked).toEqual([expect.objectContaining({ model: "m1", until: (await load(dead.id)).modelLock_m1 })]);
    vi.advanceTimersByTime(3 * MIN);
    const listed = (await (await GET()).json()).models.filter((m) => m.connectionId === dead.id);
    expect(listed).toEqual([expect.objectContaining({
      model: "m1", status: "cooldown", until: record(await load(dead.id)).nextProbeAt,
      lastError: 'Demoted after repeated 403 "Not authorized for this endpoint"',
    })]);
    await succeed(dead.id, "m2");
    expect((await load(dead.id)).modelLock_m1).toBeNull();
    const res = await POST(new Request("http://localhost/api/models/availability", {
      method: "POST", body: JSON.stringify({ action: "clearCooldown", provider, model: "m1" }),
    }));
    expect(res.status).toBe(200);
    expect(record(await load(dead.id))).toBeNull();
    expect(await pick("m1")).toBe(dead.id);
  });

  it.each([
    ["is turned off", (healthy) => takePeerAway(healthy)],
    ["is rate limited on that model", (healthy) => auth.markAccountUnavailable(
      healthy.id, 429, "Too many requests", provider, "m1", Date.now() + 30 * MIN,
    )],
  ])("uses the demoted key, after its usual cooldown, when the only other key %s", async (_label, takeAway) => {
    const { dead, healthy } = await demotedKey();
    await takeAway(healthy);
    const waiting = await auth.getProviderCredentials(provider, null, "m1");
    expect(waiting.allRateLimited).toBe(true);
    expect((new Date(waiting.retryAfter).getTime() - Date.now()) / MIN).toBe(2);
    vi.advanceTimersByTime(2 * MIN);
    expect(await pick("m1")).toBe(dead.id);
    // Being the only choice takes no probe, so it doesn't push the next one back.
    await atProbe(dead.id);
    const creds = await auth.getProviderCredentials(provider, null, "m1");
    expect(creds.connectionId).toBe(dead.id);
    expect(record(await load(dead.id))).not.toHaveProperty("probeId");
    await auth.clearAccountError(dead.id, creds, "m1");
    expect(record(await load(dead.id))).toBeNull();
  });

  const NO_ACCESS = '[403]: {"error":{"message":"Your organization does not have access to model claude-opus-5-5"}}';
  const OPUS_M = "claude-opus-5-5";
  const KIMI_M = "kimi-k3";

  it("demotes on 403s that refuse just that model, and never turns the key off for them", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 12, models: ["claude-opus-5-5"], peers: [healthy], text: NO_ACCESS });
    const conn = await load(dead.id);
    expect(conn.isActive).toBe(true);
    expect(conn).not.toHaveProperty("authFailCount");
    expect(record(conn, "claude-opus-5-5")).toMatchObject({ modelScoped: true, demotedAt: expect.any(String) });
  });

  it.each([
    [403, '{"error":{"message":"Key limit exceeded for model claude-opus-5-5"}}'],
    [403, "Your plan does not include model claude-opus-5-5: model not available"],
    [401, "model claude-opus-5-5 is not enabled for this key"],
    [403, '{"error":{"code":"rate_limit_exceeded","message":"model claude-opus-5-5 not available"}}'],
    [403, "Premium requests for model claude-opus-5-5 are not allowed"],
  ])("never counts %i %s toward a demotion", async (status, text) => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 8, models: ["claude-opus-5-5"], peers: [healthy], status, text });
    expect(record(await load(dead.id), "claude-opus-5-5")).toBeNull();
  });

  it("does not count a 403 refusing just that model without a peer serving it", async () => {
    const dead = await addKey("a");
    await addKey("b");
    await fail(dead.id, { times: 8, models: ["m1"], text: NO_ACCESS });
    expect(record(await load(dead.id))).toBeNull();
  });

  // After a pause the turn-off rule's own count starts over, so only these
  // rules can see the key refused on 2 models; then m1's probe is refused.
  async function pausedThenProbed(dead, healthy) {
    vi.advanceTimersByTime(11 * MIN);
    await fail(dead.id, { times: 1, models: ["m1"], peers: [healthy] });
    expect(await load(dead.id)).toMatchObject({ isActive: true, authFailCount: 1 });
  }

  it("turns a demoted key off on a 2nd refusal on another model within 10 minutes, having served nothing", async () => {
    const { warn } = await import("@/sse/utils/logger.js");
    warn.mockClear();
    const { dead, healthy } = await demotedKey();
    await pausedThenProbed(dead, healthy);
    vi.advanceTimersByTime(2 * MIN);
    await fail(dead.id, { times: 1, models: ["m2"], peers: [healthy] });
    expect((await load(dead.id)).isActive).toBe(true);
    vi.advanceTimersByTime(2 * MIN);
    await fail(dead.id, { times: 1, models: ["m2"], peers: [healthy] });
    expect(await load(dead.id)).toMatchObject({ isActive: false, autoDisabledReason: '403 "Not authorized for this endpoint" on m1, m2' });
    expect(warn).toHaveBeenCalledWith("AUTH", 'a turned off automatically: 403 "Not authorized for this endpoint" on m1, m2');
  });

  it.each([
    [10, false],
    [10 + 1 / 60000, true],
  ])("treats a refusal on m1 %i minutes before the 2nd on m2 as recent: %s", async (minutes, stillOn) => {
    const { dead, healthy } = await demotedKey();
    await pausedThenProbed(dead, healthy);
    vi.advanceTimersByTime(minutes * MIN - 2 * MIN);
    await fail(dead.id, { times: 2, models: ["m2"], peers: [healthy], stepMs: 2 * MIN });
    expect((await load(dead.id)).isActive).toBe(stillOn);
  });

  it.each([
    ["refused", false, '403 "Not authorized for this endpoint" on m2, m1'],
    ["served", true, undefined],
  ])("probes a demoted model right after another model refuses the key, and turns it off only if the probe is %s too", async (
    _label, recovered, reason,
  ) => {
    const { dead, healthy } = await demotedKey();
    vi.advanceTimersByTime(15 * MIN);
    await fail(dead.id, { times: 1, models: ["m2"], peers: [healthy] });
    expect((await load(dead.id)).isActive).toBe(true);
    expect(new Date(record(await load(dead.id)).nextProbeAt).getTime()).toBeLessThanOrEqual(Date.now());
    vi.advanceTimersByTime(MIN);
    const probe = await auth.getProviderCredentials(provider, null, "m1");
    expect(probe.connectionId).toBe(dead.id);
    if (recovered) await auth.clearAccountError(dead.id, probe, "m1");
    else {
      await succeed(healthy.id, "m1");
      await failOnce(dead.id, "m1");
    }
    const conn = await load(dead.id);
    expect(conn.isActive).toBe(recovered);
    expect(conn.autoDisabledReason).toBe(reason);
  });

  it("turns a key off as the refusal that demotes it on m2 comes within m1's probe interval and 10 minutes", async () => {
    const { dead, healthy } = await demotedKey();
    await pausedThenProbed(dead, healthy);
    vi.advanceTimersByTime(11 * MIN);
    await fail(dead.id, { times: 4, models: ["m2"], peers: [healthy], stepMs: 2 * MIN });
    expect(await load(dead.id)).toMatchObject({ isActive: true, authDemote_m2: { count: 4 } });
    vi.advanceTimersByTime(4 * MIN);
    await fail(dead.id, { times: 1, models: ["m2"], peers: [healthy] });
    expect(await load(dead.id)).toMatchObject({ isActive: false, autoDisabledReason: '403 "Not authorized for this endpoint" on m1, m2' });
  });

  it("does not let 401s on another model turn a demoted key off without the turn-off rule's own count", async () => {
    const { dead, healthy } = await demotedKey();
    await pausedThenProbed(dead, healthy);
    await fail(dead.id, { times: 2, models: ["m2"], peers: [healthy], status: 401, text: "Invalid API key", stepMs: 2 * MIN });
    expect((await load(dead.id)).isActive).toBe(true);
  });

  it.each([
    ["it served another model since the demotion", async (dead) => succeed(dead.id, "m3")],
    ["it served another model since, before a restart", async (dead) => {
      await succeed(dead.id, "m3");
      global._authEvents.success.clear();
      global._authEvents.refused.clear();
    }],
    ["its last refusal there is older than the probe interval and 10 minutes", async () => vi.advanceTimersByTime(25 * MIN)],
  ])("keeps a demoted key on when another model refuses it but %s", async (_label, between) => {
    const { dead, healthy } = await demotedKey();
    await between(dead);
    vi.advanceTimersByTime(3 * MIN);
    await fail(dead.id, { times: 1, models: ["m2"], peers: [healthy] });
    expect((await load(dead.id)).isActive).toBe(true);
  });

  it("keeps a demoted key on that another model refuses after a success read from a snapshot older than the demotion", async () => {
    const { dead, healthy } = await demotedKey();
    vi.advanceTimersByTime(MIN);
    await auth.clearAccountError(dead.id, { id: dead.id }, "m3");
    vi.advanceTimersByTime(3 * MIN);
    await fail(dead.id, { times: 1, models: ["m2"], peers: [healthy] });
    expect((await load(dead.id)).isActive).toBe(true);
  });

  it("does not demote a key refused on another model within the window", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 6, models: ["m1", "m1", "m1", "m2", "m1", "m1"], peers: [healthy] });
    const conn = await load(dead.id);
    expect(record(conn)).toMatchObject({ count: 5 });
    expect(demoted(conn)).toBe(false);
  });

  it("does not count a refusal of just that model while the only peer serving it was refused there since", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await succeed(healthy.id, "m1");
    await failOnce(healthy.id, "m1");
    await failOnce(dead.id, "m1", 403, NO_ACCESS);
    expect(record(await load(dead.id))).toBeNull();
  });

  it("does not treat a demotion that included refusals of just that model as a sign the key is dead", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 2, models: ["m1"], peers: [healthy], text: NO_ACCESS });
    vi.advanceTimersByTime(3 * MIN);
    await fail(dead.id, { times: 3, models: ["m1"], peers: [healthy] });
    expect(record(await load(dead.id))).toMatchObject({ modelScoped: true, demotedAt: expect.any(String) });
    await pausedThenProbed(dead, healthy);
    await fail(dead.id, { times: 2, models: ["m2"], peers: [healthy], stepMs: 2 * MIN });
    expect((await load(dead.id)).isActive).toBe(true);
  });

  it("does not probe at once a demotion for refusals of just that model when another model refuses the key", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 5, models: ["m1"], peers: [healthy], text: NO_ACCESS });
    const { nextProbeAt } = record(await load(dead.id));
    vi.advanceTimersByTime(3 * MIN);
    await fail(dead.id, { times: 1, models: ["m2"], peers: [healthy] });
    expect(record(await load(dead.id)).nextProbeAt).toBe(nextProbeAt);
  });

  it("counts a success it could not write as served, so another model's refusals don't turn the key off", async () => {
    const { dead, healthy } = await demotedKey();
    vi.advanceTimersByTime(MIN);
    global._authEvents.demoteKeys.clear();
    await auth.clearAccountError(dead.id, { id: dead.id }, "m3");
    expect((await load(dead.id)).authDemoteOkAt).toBeUndefined();
    await pausedThenProbed(dead, healthy);
    await fail(dead.id, { times: 2, models: ["m2"], peers: [healthy], stepMs: 2 * MIN });
    expect((await load(dead.id)).isActive).toBe(true);
  });

  it("keeps a key on that another model refuses after a demotion for refusals of just one model", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 5, models: ["m1"], peers: [healthy], text: NO_ACCESS });
    expect(demoted(await load(dead.id))).toBe(true);
    vi.advanceTimersByTime(3 * MIN);
    await fail(dead.id, { times: 1, models: ["m2"], peers: [healthy] });
    expect((await load(dead.id)).isActive).toBe(true);
  });

  it("lifts a demotion right away through a success on that model read from a snapshot older than it", async () => {
    const { dead } = await demotedKey();
    vi.advanceTimersByTime(3 * MIN);
    await auth.clearAccountError(dead.id, { id: dead.id }, "m1");
    expect(record(await load(dead.id))).toBeNull();
    expect(await pick("m1")).toBe(dead.id);
  });

  it("brings a key back in this process after a success on that model it could not write, and clears the record on the next", async () => {
    const { dead } = await demotedKey();
    vi.advanceTimersByTime(3 * MIN);
    global._authEvents.demoteKeys.clear();
    await auth.clearAccountError(dead.id, { id: dead.id }, "m1");
    expect(record(await load(dead.id))).toMatchObject({ demotedAt: expect.any(String) });
    const creds = await auth.getProviderCredentials(provider, null, "m1");
    expect(creds.connectionId).toBe(dead.id);
    await auth.clearAccountError(dead.id, creds, "m1");
    expect(record(await load(dead.id))).toBeNull();
  });

  it("lifts the demotion through a success whose snapshot has no record but other errors to clear", async () => {
    const { dead } = await demotedKey();
    await auth.clearAccountError(dead.id, { id: dead.id, lastError: "x", testStatus: "unavailable" }, "m1");
    expect(record(await load(dead.id))).toBeNull();
  });

  it("lifts the demotion on a success on that model when another model's rate limit leaves nothing else to clear", async () => {
    const { dead } = await demotedKey();
    vi.advanceTimersByTime(3 * MIN);
    await succeed(dead.id, "m2");
    await auth.markAccountUnavailable(dead.id, 429, "Too many requests", provider, "m2", Date.now() + 30 * MIN);
    await succeed(dead.id, "m1");
    expect(record(await load(dead.id))).toBeNull();
  });

  it("still tries the key first, and takes no probe, while it is only counting", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 4, models: ["m1"], peers: [healthy] });
    vi.advanceTimersByTime(3 * MIN);
    expect(await pick("m1")).toBe(dead.id);
    expect(record(await load(dead.id))).not.toHaveProperty("probeId");
    const { GET } = await import("@/app/api/models/availability/route.js");
    expect((await (await GET()).json()).models.filter((m) => m.connectionId === dead.id && m.model === "m1")).toEqual([]);
  });

  it("takes one probe when two demoted keys are both due", async () => {
    const a = await addKey("a");
    const c = await addKey("c");
    const healthy = await addKey("b");
    for (const key of [a, c]) await fail(key.id, { times: 5, models: ["m1"], peers: [healthy] });
    await atProbe(c.id);
    const picked = await pick("m1");
    expect([a.id, c.id]).toContain(picked);
    const probes = [await load(a.id), await load(c.id)].filter((conn) => record(conn).probeId);
    expect(probes).toHaveLength(1);
  });

  it("lists a demotion only for an active key, and marks one whose probe is due", async () => {
    const { dead } = await demotedKey();
    const { GET } = await import("@/app/api/models/availability/route.js");
    const rows = async () => (await (await GET()).json()).models.filter((m) => m.connectionId === dead.id);
    await atProbe(dead.id);
    expect(await rows()).toEqual([expect.objectContaining({
      model: "m1", until: null, lastError: 'Demoted after repeated 403 "Not authorized for this endpoint" (probe due)',
    })]);
    await db.updateProviderConnection(dead.id, { isActive: false, authDemote_m2: record(await load(dead.id)) });
    expect((await rows()).filter((m) => m.model === "m1" || m.model === "m2")).toEqual([]);
  });

  it.each([
    ["kimi every 30 minutes", (m) => [OPUS_M, m % 30 === 29 ? KIMI_M : null]],
  ])("demotes on opus while the key is told it has no access to %s", async (_label, modelsAt) => {
    const dead = await addKey("a", { providerSpecificData: { baseUrl: "https://own.dead-keys.test/v1" } });
    const healthy = await addKey("b");
    for (let minute = 0; minute < 3 * 60; minute++) {
      if (minute > 0) vi.advanceTimersByTime(MIN);
      for (const model of modelsAt(minute).filter(Boolean)) {
        await succeed(healthy.id, model);
        if (model === KIMI_M) await failOnce(dead.id, model, 403, NO_ACCESS);
        else if (!((await load(dead.id))[`modelLock_${model}`] > new Date().toISOString())) await failOnce(dead.id, model);
      }
    }
    expect(demoted(await load(dead.id), OPUS_M)).toBe(true);
  });

  it.each([
    ["refuse just m1 and m2", NO_ACCESS, NO_ACCESS],
    ["refuse m1 and refuse just m2", DEAD_403, NO_ACCESS],
  ])("demotes alternating requests to a key whose answers %s", async (_label, m1Text, m2Text) => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    for (let i = 0; i < 12; i++) {
      if (i > 0) vi.advanceTimersByTime(3 * MIN);
      const model = i % 2 ? "m2" : "m1";
      await succeed(healthy.id, model);
      await failOnce(dead.id, model, 403, model === "m1" ? m1Text : m2Text);
    }
    const conn = await load(dead.id);
    expect(conn.isActive).toBe(true);
    expect([demoted(conn, "m1"), demoted(conn, "m2")]).toEqual([true, true]);
  });

  it("counts a refusal of just the model in any letter case", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 5, models: ["m1"], peers: [healthy], text: "Model m1 is not available for this API key" });
    expect(record(await load(dead.id))).toMatchObject({ modelScoped: true, demotedAt: expect.any(String) });
  });

  it("keeps the turn-off rule's evidence as on master after a refusal of just that model", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await succeed(healthy.id, "m1");
    await failOnce(dead.id, "m1", 403, NO_ACCESS);
    await failOnce(dead.id, "m1");
    expect((await load(dead.id)).authFailCount).toBe(1);
  });

  it.each([
    [403, "Model claude-opus-5-5 is overloaded and not available right now"],
    [403, "The model claude-opus-5-5 is not permitted: insufficient permissions"],
  ])("never counts %i %s toward a demotion either", async (status, text) => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 8, models: ["claude-opus-5-5"], peers: [healthy], status, text });
    expect(record(await load(dead.id), "claude-opus-5-5")).toBeNull();
  });

  it("starts the count over after a success on that model it could not write, from a refusal another process saw", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 4, models: ["m1"], peers: [healthy] });
    vi.advanceTimersByTime(MIN);
    global._authEvents.demoteKeys.clear();
    await auth.clearAccountError(dead.id, { id: dead.id }, "m1");
    vi.advanceTimersByTime(2 * MIN);
    await fail(dead.id, { times: 1, models: ["m1"], peers: [healthy] });
    expect(record(await load(dead.id))).toMatchObject({ count: 1 });
  });

  it("demotes on the 5th refusal after a success on another model it could not write", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 4, models: ["m1"], peers: [healthy] });
    global._authEvents.demoteKeys.clear();
    await auth.clearAccountError(dead.id, { id: dead.id }, "m2");
    vi.advanceTimersByTime(3 * MIN);
    await fail(dead.id, { times: 1, models: ["m1"], peers: [healthy] });
    expect(demoted(await load(dead.id))).toBe(true);
  });

  it("does not count a refusal of just that model sent with a key since replaced", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    const oldKey = (await load(dead.id)).apiKey;
    await db.updateProviderConnection(dead.id, { apiKey: "sk-test-new-0123456789" });
    await succeed(healthy.id, "m1");
    await auth.markAccountUnavailable(dead.id, 403, NO_ACCESS, provider, "m1", null, oldKey);
    expect(record(await load(dead.id))).toBeNull();
  });

  it("notes a success elsewhere once, and writes nothing on the next", async () => {
    const { dead } = await demotedKey();
    vi.advanceTimersByTime(3 * MIN);
    await succeed(dead.id, "m2");
    expect((await load(dead.id)).authDemoteOkAt).toBe(new Date().toISOString());
    const before = localDbWrites.count;
    await succeed(dead.id, "m2");
    expect(localDbWrites.count).toBe(before);
  });

  it("notes a success from a snapshot older than the demotion, so after a restart another model's refusals don't turn the key off", async () => {
    const { dead, healthy } = await demotedKey();
    vi.advanceTimersByTime(MIN);
    await auth.clearAccountError(dead.id, { id: dead.id }, "m3");
    global._authEvents.success.clear();
    global._authEvents.refused.clear();
    await pausedThenProbed(dead, healthy);
    await fail(dead.id, { times: 2, models: ["m2"], peers: [healthy], stepMs: 2 * MIN });
    expect((await load(dead.id)).isActive).toBe(true);
  });

  it("lifts a demotion through a snapshot that carries only the record", async () => {
    const { dead } = await demotedKey();
    global._authEvents.demoteKeys.clear();
    const rec = record(await load(dead.id));
    await auth.clearAccountError(dead.id, { id: dead.id, authDemote_m1: rec }, "m1");
    expect(record(await load(dead.id))).toBeNull();
  });

  it("probes a demotion at once even after the key served another model since", async () => {
    const { dead, healthy } = await demotedKey();
    await pausedThenProbed(dead, healthy);
    await succeed(dead.id, "m3");
    vi.advanceTimersByTime(MIN);
    await fail(dead.id, { times: 1, models: ["m2"], peers: [healthy] });
    expect(record(await load(dead.id)).nextProbeAt).toBe(new Date().toISOString());
  });

  it("does not hand out a second probe while one is out, even when another model's refusal makes it due", async () => {
    const { dead, healthy } = await demotedKey();
    await atProbe(dead.id);
    expect(await pick("m1")).toBe(dead.id);
    expect(await pick("m1")).toBe(healthy.id);
    await fail(dead.id, { times: 1, models: ["m2"], peers: [healthy] });
    vi.advanceTimersByTime(2 * MIN);
    expect(await pick("m1")).toBe(healthy.id);
  });

  it("does not take a refusal of just that model for the 2nd refusal there", async () => {
    const { dead, healthy } = await demotedKey();
    await pausedThenProbed(dead, healthy);
    await fail(dead.id, { times: 1, models: ["m2"], peers: [healthy], text: NO_ACCESS });
    vi.advanceTimersByTime(2 * MIN);
    await fail(dead.id, { times: 1, models: ["m2"], peers: [healthy] });
    expect((await load(dead.id)).isActive).toBe(true);
  });

  it("does not take 2 refusals on another model 15 minutes apart for a pair", async () => {
    const { dead, healthy } = await demotedKey();
    await pausedThenProbed(dead, healthy);
    await fail(dead.id, { times: 1, models: ["m2"], peers: [healthy] });
    vi.advanceTimersByTime(15 * MIN);
    await fail(dead.id, { times: 1, models: ["m1"], peers: [healthy] });
    await fail(dead.id, { times: 1, models: ["m2"], peers: [healthy] });
    expect(await load(dead.id)).toMatchObject({ isActive: true, authDemote_m2: { count: 2 } });
  });

  it("keeps a key on whose now-due probe is refused after it served another model", async () => {
    const { dead, healthy } = await demotedKey();
    vi.advanceTimersByTime(MIN);
    await succeed(dead.id, "m3");
    await pausedThenProbed(dead, healthy);
    await fail(dead.id, { times: 1, models: ["m2"], peers: [healthy] });
    vi.advanceTimersByTime(MIN);
    await fail(dead.id, { times: 1, models: ["m1"], peers: [healthy] });
    expect((await load(dead.id)).isActive).toBe(true);
  });

  it("counts a success during the count, before the demotion, as served, through a restart", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 1, models: ["m1"], peers: [healthy] });
    vi.advanceTimersByTime(MIN);
    await succeed(dead.id, "m3");
    vi.advanceTimersByTime(2 * MIN);
    await fail(dead.id, { times: 4, models: ["m1"], peers: [healthy] });
    expect(demoted(await load(dead.id))).toBe(true);
    global._authEvents.success.clear();
    global._authEvents.refused.clear();
    await pausedThenProbed(dead, healthy);
    await fail(dead.id, { times: 2, models: ["m2"], peers: [healthy], stepMs: 2 * MIN });
    expect((await load(dead.id)).isActive).toBe(true);
  });

  it.each([
    [10, false],
    [10 + 1 / 60000, true],
  ])("turns a key off when its demoted model's probe is refused %i minutes after another model's refusal: on is %s", async (minutes, stillOn) => {
    const { dead, healthy } = await demotedKey();
    vi.advanceTimersByTime(15 * MIN);
    await fail(dead.id, { times: 1, models: ["m2"], peers: [healthy] });
    vi.advanceTimersByTime(minutes * MIN);
    await succeed(healthy.id, "m1");
    await failOnce(dead.id, "m1");
    expect((await load(dead.id)).isActive).toBe(stillOn);
  });

  it("does not make other demotions due on a refused probe", async () => {
    const { dead, healthy } = await demotedKey();
    vi.advanceTimersByTime(MIN);
    await succeed(dead.id, "m3");
    vi.advanceTimersByTime(2 * MIN);
    await fail(dead.id, { times: 6, models: ["m2"], peers: [healthy], stepMs: 2 * MIN });
    expect(demoted(await load(dead.id), "m2")).toBe(true);
    const { nextProbeAt } = record(await load(dead.id), "m2");
    vi.advanceTimersByTime(MIN);
    await fail(dead.id, { times: 1, models: ["m1"], peers: [healthy] });
    expect(record(await load(dead.id), "m2").nextProbeAt).toBe(nextProbeAt);
  });

  it("does not count this key's refusal of just that model while its peer was refused just that model since serving it", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await succeed(healthy.id, "m1");
    await failOnce(healthy.id, "m1", 403, NO_ACCESS);
    await failOnce(dead.id, "m1", 403, NO_ACCESS);
    expect(record(await load(dead.id))).toBeNull();
  });

  it("still counts a generic 403 after its peer was refused just that model, as on master", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await succeed(healthy.id, "m1");
    await failOnce(healthy.id, "m1", 403, NO_ACCESS);
    await failOnce(dead.id, "m1");
    expect((await load(dead.id)).authFailCount).toBe(1);
  });

  it("notes a success after a restart for a record the snapshot shows", async () => {
    const { dead } = await demotedKey();
    vi.advanceTimersByTime(3 * MIN);
    global._authEvents.demoteKeys.clear();
    await succeed(dead.id, "m2");
    expect((await load(dead.id)).authDemoteOkAt).toBe(new Date().toISOString());
  });

  it("does not defer a demotion to a model refused only with refusals of just that model and 401s", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 4, models: ["m1"], peers: [healthy] });
    vi.advanceTimersByTime(MIN);
    await fail(dead.id, { times: 1, models: ["m2"], peers: [healthy], text: NO_ACCESS });
    await fail(dead.id, { times: 1, models: ["m2"], peers: [healthy], status: 401, text: "Invalid API key" });
    vi.advanceTimersByTime(2 * MIN);
    await fail(dead.id, { times: 1, models: ["m1"], peers: [healthy] });
    expect(demoted(await load(dead.id))).toBe(true);
  });

  it("shows a probe that is out as a cooldown until its lease ends", async () => {
    const { dead } = await demotedKey();
    await atProbe(dead.id);
    expect(await pick("m1")).toBe(dead.id);
    const { GET } = await import("@/app/api/models/availability/route.js");
    const row = (await (await GET()).json()).models.find((m) => m.connectionId === dead.id && m.model === "m1");
    expect(row.until).toBe(record(await load(dead.id)).leaseUntil);
  });

  it("writes nothing on a 2nd success after a lift", async () => {
    const { dead } = await demotedKey();
    vi.advanceTimersByTime(3 * MIN);
    await succeed(dead.id, "m1");
    const before = localDbWrites.count;
    await succeed(dead.id, "m1");
    expect(localDbWrites.count).toBe(before);
  });

  it("notes a success once for a record still counting, then writes nothing", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 2, models: ["m1"], peers: [healthy] });
    vi.advanceTimersByTime(3 * MIN);
    await succeed(dead.id, "m2");
    expect((await load(dead.id)).authDemoteOkAt).toBe(new Date().toISOString());
    const before = localDbWrites.count;
    await succeed(dead.id, "m2");
    expect(localDbWrites.count).toBe(before);
  });

  it("notes a success while another model's lock still runs", async () => {
    const { dead } = await demotedKey();
    vi.advanceTimersByTime(3 * MIN);
    await auth.markAccountUnavailable(dead.id, 429, "Too many requests", provider, "m2", Date.now() + 30 * MIN);
    await succeed(dead.id, "m3");
    expect((await load(dead.id)).authDemoteOkAt).toBe(new Date().toISOString());
  });

  it("keeps the last refusal the turn-off rule counts through a refusal of just that model", () => {
    const T = Date.parse("2026-10-23T00:00:00.000Z");
    const first = auth.__test__.nextDemoteRecord(null, T, { sameUpstream: true, reason: "403" });
    const next = auth.__test__.nextDemoteRecord(first, T + MIN, { sameUpstream: true, modelScoped: true, reason: "403" });
    expect(next.lastCountedAt).toBe(first.lastCountedAt);
  });

  it("defers a demotion to a recent refusal on a model the turn-off rule counts, past one refusing just another model", async () => {
    const dead = await addKey("a");
    const healthy = await addKey("b");
    await fail(dead.id, { times: 1, models: ["m2"], peers: [healthy], text: NO_ACCESS });
    await fail(dead.id, { times: 4, models: ["m1"], peers: [healthy] });
    vi.advanceTimersByTime(MIN);
    await fail(dead.id, { times: 1, models: ["m3"], peers: [healthy] });
    vi.advanceTimersByTime(2 * MIN);
    await fail(dead.id, { times: 1, models: ["m1"], peers: [healthy] });
    expect(record(await load(dead.id))).toMatchObject({ count: 5 });
    expect(demoted(await load(dead.id))).toBe(false);
  });

  it("does not fail on a refusal of just that model for a connection that no longer exists", async () => {
    await expect(auth.markAccountUnavailable("gone", 403, NO_ACCESS, provider, "m1")).resolves.toMatchObject({ shouldFallback: true });
  });

  it("writes the demotion message once, and lets a later error replace it", async () => {
    const { dead, healthy } = await demotedKey();
    expect((await load(dead.id)).lastError).toBe(MESSAGE);
    vi.advanceTimersByTime(3 * MIN);
    await fail(dead.id, { times: 1, models: ["m1"], peers: [healthy] });
    expect((await load(dead.id)).lastError).toBe(DEAD_403.slice(0, 100));
    await failOnce(dead.id, "m2", 429, "Too many requests");
    expect(await load(dead.id)).toMatchObject({ lastError: "Too many requests", authDemote_m1: { demotedAt: expect.any(String) } });
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

  // Requests as the router serves them, minute by minute: modelsAt(minute) is
  // the models asked for that minute, refuses(model, minute) whether the key is
  // refused on one. Returns the minutes it was refused on each model, the
  // minutes it was demoted, and who served each request.
  async function watch(key, { modelsAt, totalMin, refuses = () => true, text = DEAD_403 }) {
    // One request as route() serves it, refused on `key` with `text`.
    async function serve(model, refused) {
      const tried = new Set();
      for (;;) {
        const creds = await auth.getProviderCredentials(provider, tried, model);
        if (!creds?.connectionId) return null;
        if (!(refused && creds.connectionId === key.id)) {
          await auth.clearAccountError(creds.connectionId, creds, model);
          return creds.connectionId;
        }
        await failOnce(creds.connectionId, model, 403, typeof text === "function" ? text(model) : text);
        tried.add(creds.connectionId);
      }
    }
    const refusals = {};
    const demotions = [];
    const served = [];
    for (let minute = 0; minute < totalMin; minute++) {
      if (minute > 0) vi.advanceTimersByTime(MIN);
      for (const model of [modelsAt(minute)].flat().filter(Boolean)) {
        const before = await load(key.id);
        const servedBy = await serve(model, refuses(model, minute));
        served.push([minute, model, servedBy]);
        const conn = await load(key.id);
        expect(conn.isActive).toBe(true);
        if (conn.lastErrorAt && conn.lastErrorAt !== before.lastErrorAt) (refusals[model] ??= []).push(minute);
        if (conn[`authDemote_${model}`]?.demotedAt && !before[`authDemote_${model}`]?.demotedAt) demotions.push([minute, model]);
      }
    }
    return { refusals, demotions, served };
  }

  const OPUS = "claude-opus-5-5";
  const KIMI = "kimi-k3";
  const opusOnly = (workMin, idleMin) => (minute) => (minute % (workMin + idleMin) < workMin ? OPUS : null);

  // The live case of 2026-10-28: only claude-opus-5-5 in use, someone working
  // 10 minutes and pausing 13; master refuses the dead key 159 times in 12 hours.
  it.each([
    ["on another account", "acct-dead", "acct-live", 60, 75, 16, 22],
    ["on the same account", "acct-shared", "acct-shared", 20, 30, 7, 13],
  ])("demotes a dead key refused on the only model in use, its peer %s, and keeps trying it rarely", async (
    _label, own, peer, minDemoteMin, maxDemoteMin, maxBefore, maxTotal,
  ) => {
    const dead = await addKey("a", snowflake(own, own === peer ? {} : { ownBaseUrl: true }));
    const healthy = await addKey("b", snowflake(peer));
    const { refusals, demotions } = await watch(dead, { modelsAt: opusOnly(10, 13), totalMin: 12 * 60 });
    const [[demotedAt]] = demotions;
    expect(demotedAt - refusals[OPUS][0]).toBeGreaterThanOrEqual(minDemoteMin);
    expect(demotedAt - refusals[OPUS][0]).toBeLessThanOrEqual(maxDemoteMin);
    expect(refusals[OPUS].filter((m) => m <= demotedAt).length).toBeLessThanOrEqual(maxBefore);
    expect(refusals[OPUS].length).toBeLessThanOrEqual(maxTotal);
    expect((await load(healthy.id)).isActive).toBe(true);
  }, 60000);

  it.each([
    ["on the same account, kimi every 3 minutes", "acct-shared", "acct-shared", 3, 3 * 60, 15],
    ["on another account, kimi every 20 minutes", "acct-dead", "acct-live", 20, 10 * 60, 40],
  ])("demotes a key that lacks opus but serves kimi, its peer %s, and keeps serving kimi", async (
    _label, own, peer, kimiEveryMin, totalMin, maxOpusRefusals,
  ) => {
    const partial = await addKey("a", snowflake(own, own === peer ? {} : { ownBaseUrl: true }));
    await addKey("b", snowflake(peer));
    const modelsAt = (minute) => [OPUS, minute % kimiEveryMin === kimiEveryMin - 1 ? KIMI : null];
    const { refusals, demotions, served } = await watch(partial, {
      modelsAt, totalMin, refuses: (model) => model === OPUS,
    });
    expect(demotions.map(([, model]) => model)).toEqual([OPUS]);
    expect(refusals[OPUS].length).toBeLessThanOrEqual(maxOpusRefusals);
    expect(served.filter(([, model]) => model === KIMI).every(([, , id]) => id === partial.id)).toBe(true);
  }, 60000);

  it("brings a key back within a probe of a 30-minute incident on one model ending, through 403s elsewhere", async () => {
    const key = await addKey("a", snowflake("acct-shared"));
    await addKey("b", snowflake("acct-shared"));
    const modelsAt = (minute) => ["m1", minute === 48 || minute === 52 ? "m2" : null];
    const refuses = (model, minute) => (model === "m1" ? minute < 30 : minute === 48 || minute === 52);
    const { demotions, served } = await watch(key, { modelsAt, totalMin: 90, refuses });
    // Its first refusal has no peer success before it, so counting starts at minute 2.
    expect(demotions).toEqual([[12, "m1"]]);
    // The probe at 22 is refused; the next, 20 minutes on, finds m1 working.
    const back = served.find(([minute, model, id]) => minute >= 30 && model === "m1" && id === key.id)[0];
    expect(back).toBe(42);
    expect(served.filter(([minute, model]) => model === "m1" && minute >= back).every(([, , id]) => id === key.id)).toBe(true);
  }, 60000);
  const SONNET = "claude-sonnet-5-5";
  const HAIKU = "claude-haiku-5-5";
  const inSession = (minute) => minute % 23 < 10;
  const PATTERNS = {
    "sonnet, then opus": (m) => (inSession(m) ? (m < 180 ? SONNET : OPUS) : null),
    "sessions alternating sonnet and opus": (m) => (inSession(m) ? (Math.floor(m / 23) % 2 ? OPUS : SONNET) : null),
    "opus, and sonnet every 2 hours": (m) => (m % 120 === 60 ? SONNET : inSession(m) ? OPUS : null),
    "opus, then haiku": (m) => (inSession(m) ? (m < 180 ? OPUS : HAIKU) : null),
  };
  const UPSTREAMS = [["on the same account", "acct-shared", "acct-shared"], ["on another account", "acct-dead", "acct-live"]];
  const keysOn = async (own, peer) => [
    await addKey("a", snowflake(own, own === peer ? {} : { ownBaseUrl: true })), await addKey("b", snowflake(peer)),
  ];

  // Minutes until master turns these off: null for never. Demoting each model
  // in turn must turn them off no later.
  it.each([
    ["sonnet, then opus", 0, null, 210],
    ["sonnet, then opus", 1, 186, 186],
    ["sessions alternating sonnet and opus", 0, null, null],
    ["sessions alternating sonnet and opus", 1, 69, 69],
    ["opus, and sonnet every 2 hours", 0, 190, 184],
    ["opus, and sonnet every 2 hours", 1, 180, 180],
    ["opus, then haiku", 0, null, 210],
    ["opus, then haiku", 1, 186, 186],
  ])("turns off a key dead on every model someone uses one at a time (%s), its peer %s (0 same account, 1 another), master at %s, by %s", async (
    name, upstream, _master, byMin,
  ) => {
    const [, own, peer] = UPSTREAMS[upstream];
    const [dead] = await keysOn(own, peer);
    const minutes = await drive(dead, { modelAt: PATTERNS[name], totalMin: 12 * 60 });
    if (byMin === null) expect(minutes).toBeNull();
    else expect(minutes).toBeLessThanOrEqual(byMin);
  }, 60000);

  it.each([
    ...["sonnet, then opus", "sessions alternating sonnet and opus", "opus, and sonnet every 2 hours"].map((name) => [name, PATTERNS[name]]),
    ["opus, then haiku, and sonnet every 2 hours", (m) => (m % 120 === 60 ? SONNET : PATTERNS["opus, then haiku"](m))],
  ].flatMap(([name, modelsAt]) => UPSTREAMS.map(([where, own, peer]) => [name, where, own, peer, modelsAt])))(
    "never turns off a key that lacks opus and haiku but serves sonnet (%s), its peer %s",
    async (_name, _where, own, peer, modelsAt) => {
      const [partial] = await keysOn(own, peer);
      const { served } = await watch(partial, { modelsAt, totalMin: 12 * 60, refuses: (model) => model !== SONNET });
      expect(served.filter(([, model]) => model === SONNET).every(([, , id]) => id === partial.id)).toBe(true);
    }, 60000,
  );

  it("demotes a dead key on opus, its peer on another account, while kimi answers that the key has no access", async () => {
    const [dead] = await keysOn("acct-dead", "acct-live");
    const noAccess = '[403]: {"error":{"message":"Your organization does not have access to model kimi-k3"}}';
    const { refusals, demotions } = await watch(dead, {
      modelsAt: (m) => [OPUS, m % 30 === 29 ? KIMI : null], totalMin: 12 * 60, text: (model) => (model === KIMI ? noAccess : DEAD_403),
    });
    expect(demotions.map(([, model]) => model).sort()).toEqual([KIMI, OPUS].sort());
    expect(refusals[OPUS].length).toBeLessThanOrEqual(40);
  }, 60000);

  it.each(UPSTREAMS)("demotes a key refused on opus and kimi that serves sonnet on both, its peer %s, and keeps it on", async (_where, own, peer) => {
    const [partial] = await keysOn(own, peer);
    const SONNET_M = "claude-sonnet-5-5";
    const { refusals, demotions } = await watch(partial, {
      modelsAt: () => [OPUS, KIMI, SONNET_M], totalMin: 6 * 60, refuses: (model) => model !== SONNET_M,
    });
    expect(demotions.map(([, model]) => model).sort()).toEqual([KIMI, OPUS].sort());
    expect(refusals[OPUS].length + refusals[KIMI].length).toBeLessThanOrEqual(60);
  }, 60000);

  it.each(UPSTREAMS)("demotes a dead key used for opus every 12 minutes after one refusal on kimi, its peer %s", async (_where, own, peer) => {
    const [dead] = await keysOn(own, peer);
    const { refusals, demotions } = await watch(dead, { modelsAt: (m) => (m === 3 ? KIMI : m % 12 === 0 ? OPUS : null), totalMin: 12 * 60 });
    expect(demotions.map(([, model]) => model)).toEqual([OPUS]);
    expect(refusals[OPUS].length).toBeLessThanOrEqual(13);
  }, 60000);

  it.each([
    ["on the same account", "acct-shared", "acct-shared", 11],
    ["on another account", "acct-dead", "acct-live", 35],
  ])("demotes a key told it has no access to opus, its peer %s", async (_where, own, peer, maxRefusals) => {
    const [partial] = await keysOn(own, peer);
    const text = '[403]: {"error":{"message":"Your organization does not have access to model claude-opus-5-5"}}';
    const { refusals, demotions } = await watch(partial, { modelsAt: () => OPUS, totalMin: 3 * 60, text });
    expect(demotions.map(([, model]) => model)).toEqual([OPUS]);
    expect(refusals[OPUS].length).toBeLessThanOrEqual(maxRefusals);
  }, 60000);
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
