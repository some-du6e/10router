// A key refused for itself on a model while other keys serve it is soft-demoted
// there: tried after them, but for one try on the probe schedule, and its
// refusals there stop counting toward turning it off. Runs against the real
// SQLite repo.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: { json: (body, init = {}) => new Response(JSON.stringify(body), { status: init.status || 200 }) },
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

const originalDataDir = process.env.DATA_DIR;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-soft-demote-"));
process.env.DATA_DIR = tempDir;

const DEAD_403 = '[403]: {"code":"003001","message":"Not authorized for this endpoint"}';
const MIN = 60 * 1000;
const OPUS = "claude-opus-5-5";
const KIMI = "kimi-k3";
const STREAK_FIELDS = [
  "authFailCount", "authFailFirstAt", "authFailLastAt", "authFailModels", "authFailAll401",
  "authFailSameUpstream", "authFailRunCount", "authFailRunStartAt", "authFailBursts",
];

let db, auth, provider;
let seq = 0;

beforeAll(async () => {
  db = await import("@/lib/db/index.js");
  auth = await import("@/sse/services/auth.js");
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-13T00:00:00.000Z"));
  provider = `openai-compatible-chat-test-soft-${++seq}`;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// Each key on its own account, its own base URL.
async function accounts(...names) {
  const keys = [];
  for (const name of names) {
    keys.push(await db.createProviderConnection({
      provider, authType: "apikey", name, apiKey: `sk-test-${name}-0123456789`,
      providerSpecificData: { baseUrl: `https://acct-${name}.acme.test/v1`, ownBaseUrl: true },
    }));
  }
  return keys;
}

const load = (id) => db.getProviderConnectionById(id);
const pick = async (model) => (await auth.getProviderCredentials(provider, null, model))?.connectionId;
const succeed = async (id, model) => auth.clearAccountError(id, await load(id), model);
const failOnce = (id, model) => auth.markAccountUnavailable(id, 403, DEAD_403, provider, model);
const evidenceOf = (conn, model) => Object.fromEntries([...STREAK_FIELDS, `authDemote_${model}`].map((f) => [f, conn[f] ?? null]));

// The peer serves the model, then the key is refused: every `stepMs`.
async function refuse(id, peer, { times, model = OPUS, stepMs = 2 * MIN }) {
  for (let i = 0; i < times; i++) {
    if (i > 0) vi.advanceTimersByTime(stepMs);
    await succeed(peer.id, model);
    await failOnce(id, model);
  }
}

// 6 refusals over 10 minutes: soft-demoted at the last.
async function softDemoted() {
  const [key, peer] = await accounts("a", "b");
  await refuse(key.id, peer, { times: 6 });
  return { key, peer };
}

describe("soft demotion", () => {
  it("tries the key after its peer on that model, and first on the others", async () => {
    const [key, peer] = await accounts("a", "b");
    await refuse(key.id, peer, { times: 5 });
    vi.advanceTimersByTime(3 * MIN);
    expect(await pick(OPUS)).toBe(key.id);

    await refuse(key.id, peer, { times: 1 });
    vi.advanceTimersByTime(3 * MIN);
    expect(await pick(OPUS)).toBe(peer.id);
    expect(await pick(KIMI)).toBe(key.id);
    expect((await load(key.id)).isActive).toBe(true);
  });

  it("lifts on a success of the key on that model", async () => {
    const { key, peer } = await softDemoted();
    vi.advanceTimersByTime(3 * MIN);
    expect(await pick(OPUS)).toBe(peer.id);
    await succeed(key.id, OPUS);
    expect(await pick(OPUS)).toBe(key.id);
  });

  it("gives the key one try 10 minutes on, then 20, 40, 90 and 180 after each refused one", async () => {
    const { key, peer } = await softDemoted();
    const waits = [];
    for (let i = 0; i < 6; i++) {
      let wait = 0;
      do {
        vi.advanceTimersByTime(MIN);
        wait++;
      } while (await pick(OPUS) !== key.id && wait < 200);
      waits.push(wait);
      await succeed(peer.id, OPUS);
      await failOnce(key.id, OPUS);
    }
    expect(waits).toEqual([10, 20, 40, 90, 180, 180]);
    expect((await load(key.id)).isActive).toBe(true);
  });

  it("takes one soft try per pass", async () => {
    const [a, b, peer] = await accounts("a", "b", "c");
    for (let i = 0; i < 6; i++) {
      if (i > 0) vi.advanceTimersByTime(2 * MIN);
      for (const key of [a, b]) {
        await succeed(peer.id, OPUS);
        await failOnce(key.id, OPUS);
      }
    }
    vi.advanceTimersByTime(10 * MIN);
    const tried = new Set();
    const order = [];
    for (;;) {
      const creds = await auth.getProviderCredentials(provider, tried, OPUS);
      order.push(creds.connectionId);
      if (creds.connectionId === peer.id) break;
      await failOnce(creds.connectionId, OPUS);
      tried.add(creds.connectionId);
    }
    expect(order).toEqual([a.id, peer.id]);
  });

  it("forgets the key's counted refusals on that model when it soft-demotes it", async () => {
    const [key, peer] = await accounts("a", "b");
    await refuse(key.id, peer, { times: 5 });
    expect(await load(key.id)).toMatchObject({ authFailCount: 5, [`authDemote_${OPUS}`]: { count: 5 } });

    vi.advanceTimersByTime(2 * MIN);
    await refuse(key.id, peer, { times: 1 });
    expect(evidenceOf(await load(key.id), OPUS)).toEqual(evidenceOf({}, OPUS));
  });

  it("doesn't count a refusal while soft-demoted toward turning the key off or demoting it", async () => {
    const { key, peer } = await softDemoted();
    await refuse(key.id, peer, { times: 1, model: KIMI });
    const before = evidenceOf(await load(key.id), OPUS);
    expect(before.authFailCount).toBe(1);

    vi.advanceTimersByTime(10 * MIN);
    expect(await pick(OPUS)).toBe(key.id);
    await succeed(peer.id, OPUS);
    await failOnce(key.id, OPUS);
    const conn = await load(key.id);
    expect(evidenceOf(conn, OPUS)).toEqual(before);
    expect(conn).toMatchObject({ errorCode: 403, isActive: true });
    expect(conn[`modelLock_${OPUS}`]).toBeTruthy();
  });

  it("starts over for a new key pasted in", async () => {
    const { key, peer } = await softDemoted();
    vi.advanceTimersByTime(3 * MIN);
    expect(await pick(OPUS)).toBe(peer.id);
    await db.updateProviderConnection(key.id, { apiKey: "sk-test-a-replaced-0123456789" });
    expect(await pick(OPUS)).toBe(key.id);
  });
});

describe("AUTH_SOFT_DEMOTE", () => {
  it.each([
    [undefined, true],
    ["1", true],
    ["0", false],
    [" 0 ", false],
    ["2", true],
    ["off", true],
    ["-1", true],
  ])("reads %j as enabled: %s", async (raw, enabled) => {
    if (raw !== undefined) vi.stubEnv("AUTH_SOFT_DEMOTE", raw);
    vi.resetModules();
    const { AUTH_SOFT_DEMOTE } = await import("open-sse/config/runtimeConfig.js");
    const { AUTH_DEMOTE_CONFIG } = await import("open-sse/config/errorConfig.js");
    expect(AUTH_SOFT_DEMOTE).toEqual({
      enabled, probeMs: AUTH_DEMOTE_CONFIG.probeMs, probeLeaseMs: AUTH_DEMOTE_CONFIG.probeLeaseMs,
    });
  });
});
