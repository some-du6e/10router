// A key whose auth keeps failing is turned off (with a reason) instead of being
// retried every time its per-model lock expires, and comes back on when the user
// re-enables it or a connection test passes. Runs against the real SQLite repo.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: { json: (body, init = {}) => new Response(JSON.stringify(body), { status: init.status || 200 }) },
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

const originalDataDir = process.env.DATA_DIR;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-auto-disable-"));
process.env.DATA_DIR = tempDir;

const PROVIDER = "openai-compatible-chat-test-dead-keys";
const DEAD_403 = '[403]: {"code":"003001","message":"Not authorized for this endpoint"}';
const MIN = 60 * 1000;

let db, auth, testSingleConnection, testBatch;
let seq = 0;

beforeAll(async () => {
  db = await import("@/lib/db/index.js");
  auth = await import("@/sse/services/auth.js");
  ({ testSingleConnection } = await import("@/app/api/providers/[id]/test/testUtils.js"));
  ({ POST: testBatch } = await import("@/app/api/providers/test-batch/route.js"));
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
});

async function addKey(name, extra = {}) {
  return db.createProviderConnection({
    provider, authType: "apikey", name, apiKey: `sk-test-${name}-0123456789`,
    providerSpecificData: { baseUrl: "https://dead-keys.test/v1" }, ...extra,
  });
}

const load = (id) => db.getProviderConnectionById(id);

// One failed request every `stepMs`, cycling through `models`.
async function fail(id, { times, models, status = 403, text = DEAD_403, stepMs = 3 * MIN }) {
  for (let i = 0; i < times; i++) {
    if (i > 0) vi.advanceTimersByTime(stepMs);
    await auth.markAccountUnavailable(id, status, text, provider, models[i % models.length]);
  }
}

describe("auth-dead keys turn off", () => {
  it("turns off a key refused on two models over 10 minutes when another key is active", async () => {
    const dead = await addKey("a");
    await addKey("b");
    await fail(dead.id, { times: 5, models: ["claude-opus-5-5", "kimi-k3"] });

    const conn = await load(dead.id);
    expect(conn.isActive).toBe(false);
    expect(conn.autoDisabledAt).toBe(new Date().toISOString());
    expect(conn.autoDisabledReason).toMatch(/^403 "Not authorized for this endpoint" on claude-opus-5-5, kimi-k3 since \d\d:\d\d$/);
    expect(conn.autoDisabledReason).not.toContain("sk-test");
  });

  it("does not trip before the window has passed", async () => {
    const dead = await addKey("a");
    await addKey("b");
    await fail(dead.id, { times: 8, models: ["m1", "m2"], stepMs: MIN });
    expect((await load(dead.id)).isActive).toBe(true);
  });

  it("keeps the last active key on, with only the model lock", async () => {
    const dead = await addKey("a");
    await addKey("b", { isActive: false });
    await fail(dead.id, { times: 6, models: ["m1", "m2"] });

    const conn = await load(dead.id);
    expect(conn.isActive).toBe(true);
    expect(conn.autoDisabledAt).toBeUndefined();
    expect(conn.modelLock_m2).toBeTruthy();
  });

  it("keeps a key refused on a single model on", async () => {
    const dead = await addKey("a");
    await addKey("b");
    await fail(dead.id, { times: 10, models: ["claude-opus-5-5"] });
    expect((await load(dead.id)).isActive).toBe(true);
  });

  it("starts over after a success on any model", async () => {
    const dead = await addKey("a");
    await addKey("b");
    await fail(dead.id, { times: 4, models: ["m1", "m2"] });
    await auth.clearAccountError(dead.id, await load(dead.id), "m3");
    expect((await load(dead.id)).authFailCount).toBeNull();

    vi.advanceTimersByTime(3 * MIN);
    await fail(dead.id, { times: 4, models: ["m1", "m2"] });
    expect((await load(dead.id)).isActive).toBe(true);
  });

  it.each([
    [429, "Too many requests"],
    [500, "Internal server error"],
    [402, "Payment required"],
    [400, "Bad request"],
    [403, "You exceeded your current quota"],
  ])("never counts %i %s", async (status, text) => {
    const dead = await addKey("a");
    await addKey("b");
    await fail(dead.id, { times: 8, models: ["m1", "m2"], status, text });

    const conn = await load(dead.id);
    expect(conn.isActive).toBe(true);
    expect(conn.authFailCount).toBeUndefined();
  });

  it("does not reset the streak on a non-auth error in between", async () => {
    const dead = await addKey("a");
    await addKey("b");
    await fail(dead.id, { times: 3, models: ["m1", "m2"] });
    await auth.markAccountUnavailable(dead.id, 429, "Too many requests", provider, "m1");
    vi.advanceTimersByTime(3 * MIN);
    await fail(dead.id, { times: 2, models: ["m1", "m2"] });
    expect((await load(dead.id)).isActive).toBe(false);
  });

  it("trips on 401s for one model, still needing the count and window", async () => {
    const dead = await addKey("a");
    await addKey("b");
    await fail(dead.id, { times: 4, models: ["m1"], status: 401, text: "Invalid API key" });
    expect((await load(dead.id)).isActive).toBe(true);
    vi.advanceTimersByTime(3 * MIN);
    await auth.markAccountUnavailable(dead.id, 401, "Invalid API key", provider, "m1");

    const conn = await load(dead.id);
    expect(conn.isActive).toBe(false);
    expect(conn.autoDisabledReason).toMatch(/^401 "Invalid API key" on m1 since/);
  });
});

describe("turning an auto-disabled key back on", () => {
  async function deadKey() {
    const dead = await addKey("a");
    await addKey("b");
    await fail(dead.id, { times: 5, models: ["m1", "m2"] });
    expect((await load(dead.id)).isActive).toBe(false);
    return dead;
  }

  async function expectBackOn(id) {
    const conn = await load(id);
    expect(conn.isActive).toBe(true);
    for (const field of ["autoDisabledAt", "autoDisabledReason", "authFailCount", "authFailFirstAt", "authFailModels"]) {
      expect(conn).not.toHaveProperty(field);
    }
  }

  it("clears the reason and streak when re-enabled", async () => {
    const dead = await deadKey();
    await db.updateProviderConnection(dead.id, { isActive: true });
    await expectBackOn(dead.id);
  });

  it("re-enables when the key is added again", async () => {
    const dead = await deadKey();
    await db.createProviderConnection({ provider, authType: "apikey", name: "a", apiKey: "sk-test-new-0123456789" });
    await expectBackOn(dead.id);
  });

  it("re-enables an auto-disabled key whose connection test passes", async () => {
    const dead = await deadKey();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    expect((await testSingleConnection(dead.id)).valid).toBe(true);
    await expectBackOn(dead.id);
  });

  it("leaves an auto-disabled key off when its test fails", async () => {
    const dead = await deadKey();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 403 })));
    expect((await testSingleConnection(dead.id)).valid).toBe(false);
    expect((await load(dead.id)).isActive).toBe(false);
  });

  it("leaves a key the user turned off alone when its test passes", async () => {
    const manual = await addKey("a", { isActive: false });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    expect((await testSingleConnection(manual.id)).valid).toBe(true);
    expect((await load(manual.id)).isActive).toBe(false);
  });

  it("tests auto-disabled keys in a batch, but not ones the user turned off", async () => {
    const dead = await deadKey();
    const manual = await addKey("c", { isActive: false });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const res = await testBatch(new Request("http://localhost/api/providers/test-batch", {
      method: "POST", body: JSON.stringify({ mode: "provider", providerId: provider }),
    }));
    const tested = (await res.json()).results.map((r) => r.connectionId);
    expect(tested).toContain(dead.id);
    expect(tested).not.toContain(manual.id);
    await expectBackOn(dead.id);
    expect((await load(manual.id)).isActive).toBe(false);
  });
});
