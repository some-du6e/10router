// A key on its own account, refused for itself on a model while other keys
// serve it, is soft-demoted there: tried after them but for a try on the probe
// schedule, and its refusals there stop counting toward turning it off. Runs
// against the real SQLite repo.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: { json: (body, init = {}) => new Response(JSON.stringify(body), { status: init.status || 200 }) },
}));
const logged = vi.hoisted(() => ({ warn: [], info: [] }));
vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(), error: vi.fn(),
  warn: (...args) => logged.warn.push(args.join(" ")), info: (...args) => logged.info.push(args.join(" ")),
}));
// beforeProxyLookup(fn) runs fn inside the next refusal, after auth.js read the
// connection and before it writes.
const proxyHook = vi.hoisted(() => ({ fn: null }));
const beforeProxyLookup = (fn) => { proxyHook.fn = fn; };
vi.mock("@/lib/network/connectionProxy", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    resolveConnectionProxyConfig: async (psd) => {
      const fn = proxyHook.fn;
      proxyHook.fn = null;
      await fn?.();
      return real.resolveConnectionProxyConfig(psd);
    },
  };
});

// Writes auth.js makes through localDb, and the fields of the last one.
const localDbWrites = vi.hoisted(() => ({ count: 0, last: null }));
vi.mock("@/lib/localDb", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    updateProviderConnection: async (id, data, ...rest) => {
      localDbWrites.count++;
      localDbWrites.last = data;
      return real.updateProviderConnection(id, data, ...rest);
    },
  };
});

const originalDataDir = process.env.DATA_DIR;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-soft-demote-"));
process.env.DATA_DIR = tempDir;

const REFUSED_403 = '[403]: {"code":"000000","message":"Key barred from this endpoint"}';
const MIN = 60 * 1000;
const OPUS = "claude-opus-5-5";
const KIMI = "kimi-k3";
const STREAK_FIELDS = [
  "authFailCount", "authFailFirstAt", "authFailLastAt", "authFailModels", "authFailAll401",
  "authFailSameUpstream", "authFailRunCount", "authFailRunStartAt", "authFailBursts",
];

let db, auth, availability, provider;
let seq = 0;

beforeAll(async () => {
  db = await import("@/lib/db/index.js");
  auth = await import("@/sse/services/auth.js");
  availability = await import("@/app/api/models/availability/route.js");
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

// Each key on its own account (`own`), or all on one shared account.
async function accounts(names, { shared = false } = {}) {
  const keys = [];
  for (const name of names) {
    keys.push(await db.createProviderConnection({
      provider, authType: "apikey", name, apiKey: `sk-test-${name}-0123456789`,
      providerSpecificData: shared ? { baseUrl: "https://acct-shared.acme.test/v1" }
        : { baseUrl: `https://acct-${name}.acme.test/v1`, ownBaseUrl: true },
    }));
  }
  return keys;
}

const load = (id) => db.getProviderConnectionById(id);
const pick = async (model, tried = null) => (await auth.getProviderCredentials(provider, tried, model))?.connectionId;
const succeed = async (id, model) => auth.clearAccountError(id, await load(id), model);
const failOnce = (id, model, apiKey) => auth.markAccountUnavailable(id, 403, REFUSED_403, provider, model, null, apiKey);
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
  const [key, peer] = await accounts(["a", "b"]);
  await refuse(key.id, peer, { times: 6 });
  return { key, peer };
}

// Then 6 refusals on kimi too: soft-demoted for itself on both.
async function softDemotedOnTwo() {
  const { key, peer } = await softDemoted();
  await refuse(key.id, peer, { times: 6, model: KIMI });
  return { key, peer };
}

describe("soft demotion", () => {
  it("tries the key after its peer on that model, and first on the others", async () => {
    const [key, peer] = await accounts(["a", "b"]);
    await refuse(key.id, peer, { times: 5 });
    vi.advanceTimersByTime(3 * MIN);
    expect(await pick(OPUS)).toBe(key.id);

    await refuse(key.id, peer, { times: 1 });
    vi.advanceTimersByTime(3 * MIN);
    expect(await pick(OPUS)).toBe(peer.id);
    expect(await pick(KIMI)).toBe(key.id);
    expect((await load(key.id)).isActive).toBe(true);
    expect(logged.warn).toContain(`AUTH a soft-demoted on ${OPUS} after repeated 403s`);
  });

  it("leaves a key whose peer shares its upstream to the demotion", async () => {
    const [key, peer] = await accounts(["a", "b"], { shared: true });
    await refuse(key.id, peer, { times: 6 });
    const conn = await load(key.id);
    expect(auth.__test__.softDemoted(conn, OPUS)).toBe(false);
    expect(conn[`authDemote_${OPUS}`]).toMatchObject({ demotedAt: expect.any(String) });
  });

  it("lifts on a success of the key on that model", async () => {
    const { key, peer } = await softDemoted();
    vi.advanceTimersByTime(3 * MIN);
    expect(await pick(OPUS)).toBe(peer.id);
    await succeed(key.id, OPUS);
    expect(await pick(OPUS)).toBe(key.id);
    expect(logged.info).toContain(`AUTH a soft demotion on ${OPUS} lifted`);
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

  it("makes the try due at once on a counted refusal on another model", async () => {
    const { key, peer } = await softDemoted();
    vi.advanceTimersByTime(3 * MIN);
    expect(await pick(OPUS)).toBe(peer.id);
    await refuse(key.id, peer, { times: 1, model: KIMI });
    expect(await pick(OPUS)).toBe(key.id);
    // That try is out: no other for its lease.
    expect(await pick(OPUS)).toBe(peer.id);
  });

  it("takes one soft try per pass", async () => {
    const [a, b, peer] = await accounts(["a", "b", "c"]);
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

  it("takes no soft try in a pass that used its dead-key try", async () => {
    const [soft] = await accounts(["a"]);
    const [dead, peer] = await accounts(["d", "p"], { shared: true });
    for (let i = 0; i < 6; i++) {
      if (i > 0) vi.advanceTimersByTime(2 * MIN);
      await succeed(peer.id, OPUS);
      await failOnce(soft.id, OPUS);
      await failOnce(dead.id, OPUS);
    }
    expect((await load(dead.id))[`authDemote_${OPUS}`]).toMatchObject({ demotedAt: expect.any(String) });
    vi.advanceTimersByTime(10 * MIN);
    expect(await pick(OPUS, new Set([dead.id]))).toBe(peer.id);
    expect(await pick(OPUS)).toBe(soft.id);
  });

  it("forgets the key's counted refusals on that model when it soft-demotes it, as a success there would", async () => {
    const [key, peer] = await accounts(["a", "b"]);
    await refuse(key.id, peer, { times: 5 });
    expect(await load(key.id)).toMatchObject({ authFailCount: 5, [`authDemote_${OPUS}`]: { count: 5 } });

    vi.advanceTimersByTime(2 * MIN);
    await refuse(key.id, peer, { times: 1 });
    const conn = await load(key.id);
    expect(evidenceOf(conn, OPUS)).toEqual(evidenceOf({}, OPUS));
    expect(conn.authDemoteOkAt).toBe(new Date().toISOString());
  });

  it("doesn't count a refusal while soft-demoted toward turning the key off or demoting it", async () => {
    const { key, peer } = await softDemoted();
    await refuse(key.id, peer, { times: 1, model: KIMI });
    expect((await load(key.id))[`authDemote_${KIMI}`]).toMatchObject({ count: 1 });
    const before = evidenceOf(await load(key.id), OPUS);

    vi.advanceTimersByTime(10 * MIN);
    expect(await pick(OPUS)).toBe(key.id);
    await succeed(peer.id, OPUS);
    await failOnce(key.id, OPUS);
    const conn = await load(key.id);
    expect(evidenceOf(conn, OPUS)).toEqual(before);
    expect(conn).toMatchObject({ errorCode: 403, isActive: true });
    expect(conn[`modelLock_${OPUS}`]).toBeTruthy();
  });

  it("doesn't soft-demote on a refusal sent with a key since replaced", async () => {
    const [key, peer] = await accounts(["a", "b"]);
    await refuse(key.id, peer, { times: 5 });
    vi.advanceTimersByTime(2 * MIN);
    await succeed(peer.id, OPUS);
    await failOnce(key.id, OPUS, "sk-test-a-older-0123456789");
    vi.advanceTimersByTime(3 * MIN);
    expect(await pick(OPUS)).toBe(key.id);
  });

  it("starts over for a new key pasted in", async () => {
    const { key, peer } = await softDemoted();
    vi.advanceTimersByTime(3 * MIN);
    expect(await pick(OPUS)).toBe(peer.id);
    await db.updateProviderConnection(key.id, { apiKey: "sk-test-a-replaced-0123456789" });
    expect(await pick(OPUS)).toBe(key.id);
  });

  it("ends when the key is switched off and on, after a refusal's cooldown on that model", async () => {
    const { key, peer } = await softDemoted();
    vi.advanceTimersByTime(3 * MIN);
    expect(await pick(OPUS)).toBe(peer.id);
    await db.updateProviderConnection(key.id, { isActive: false });
    await db.updateProviderConnection(key.id, { isActive: true });
    expect(await pick(KIMI)).toBe(key.id);
    expect(await pick(OPUS)).toBe(peer.id);
    vi.advanceTimersByTime(2 * MIN);
    expect(await pick(OPUS)).toBe(key.id);
  });

  it.each([
    ["with a new key", (id) => db.updateProviderConnection(id, { apiKey: "sk-test-a-new-0123456789", isActive: true })],
    ["when no other key of the provider is on", async (id, peer) => {
      await db.updateProviderConnection(peer.id, { isActive: false });
      await db.updateProviderConnection(id, { isActive: true });
    }],
  ])("ends without the cooldown when the key is switched back on %s", async (_label, switchOn) => {
    const { key, peer } = await softDemoted();
    vi.advanceTimersByTime(3 * MIN);
    await db.updateProviderConnection(key.id, { isActive: false });
    await switchOn(key.id, peer);
    const conn = await load(key.id);
    expect(conn[`authSoft_${OPUS}`] ?? null).toBeNull();
    expect(conn[`modelLock_${OPUS}`] > new Date().toISOString()).toBe(false);
    expect(await pick(OPUS)).toBe(key.id);
  });

  it("is stored on the connection, without the key, and survives a restart", async () => {
    const { key, peer } = await softDemoted();
    const record = (await load(key.id))[`authSoft_${OPUS}`];
    expect(record).toEqual({
      level: 0, since: new Date().toISOString(), tryAt: new Date(Date.now() + 10 * MIN).toISOString(),
      lastRefusedAt: new Date().toISOString(), keyRefused: true,
    });
    global._softDemotions.clear();
    for (const map of ["success", "refused", "modelRefused"]) global._authEvents[map].clear();
    vi.advanceTimersByTime(3 * MIN);
    expect(await pick(OPUS)).toBe(peer.id);
  });

  it("lists the soft demotion in model availability", async () => {
    const { key } = await softDemoted();
    const refusedAt = new Date().toISOString();
    vi.advanceTimersByTime(3 * MIN);
    const { models } = await (await availability.GET()).json();
    expect(models.filter((m) => m.connectionId === key.id && m.model === OPUS)).toEqual([expect.objectContaining({
      status: "cooldown", until: new Date(Date.parse(refusedAt) + 10 * MIN).toISOString(), lastError: `Soft-demoted: last refused ${refusedAt}`,
    })]);
  });

  it("doesn't turn it off within the first 24 hours of its soft demotion, however often it is refused elsewhere", async () => {
    // The key and its near peer on one upstream; only the far peer serves opus.
    const [key, near] = await accounts(["k", "near"], { shared: true });
    const [far] = await accounts(["far"]);
    await refuse(key.id, far, { times: 6 });
    expect(auth.__test__.softDemoted(await load(key.id), OPUS)).toBe(true);
    // Its demotions there begin over 10 minutes after anything it served, so
    // they would be firm.
    vi.advanceTimersByTime(11 * MIN);
    // Then refused on two models its near peer serves, a minute apart, for 3 hours.
    for (let i = 0; i < 180; i++) {
      vi.advanceTimersByTime(MIN);
      await refuse(key.id, near, { times: 1, model: i % 2 ? KIMI : "claude-sonnet-5-5" });
    }
    const conn = await load(key.id);
    expect(conn.isActive).toBe(true);
    expect(conn.authFailCount ?? null).toBeNull();
  });

  it("builds a streak again once it serves the soft-demoted model, not after a success elsewhere", async () => {
    const [key, near] = await accounts(["k", "near"], { shared: true });
    const [far] = await accounts(["far"]);
    await refuse(key.id, far, { times: 6 });
    vi.advanceTimersByTime(MIN);
    await succeed(key.id, KIMI);
    vi.advanceTimersByTime(MIN);
    await refuse(key.id, near, { times: 1, model: KIMI });
    expect((await load(key.id)).authFailCount ?? null).toBeNull();
    vi.advanceTimersByTime(MIN);
    await succeed(key.id, OPUS);
    vi.advanceTimersByTime(MIN);
    await refuse(key.id, near, { times: 1, model: KIMI });
    expect(await load(key.id)).toMatchObject({ authFailCount: 1, authFailSameUpstream: true });
  });

  it("refuses a key dead on two models no more often than the demotion did over 8 hours", async () => {
    const [dead, peer] = await accounts(["a", "b"]);
    for (const model of [OPUS, KIMI]) await refuse(dead.id, peer, { times: 6, model });
    let refusals = 0;
    for (let minute = 0; minute < 8 * 60; minute++) {
      vi.advanceTimersByTime(MIN);
      for (const model of [OPUS, KIMI]) {
        const tried = new Set();
        for (;;) {
          const creds = await auth.getProviderCredentials(provider, tried, model);
          if (!creds?.connectionId) break;
          if (creds.connectionId !== dead.id) {
            await succeed(creds.connectionId, model);
            break;
          }
          refusals++;
          await failOnce(dead.id, model);
          tried.add(dead.id);
        }
      }
    }
    // A try 10, 30, 70, 160 and 340 minutes in on each model.
    expect(refusals).toBeGreaterThanOrEqual(8);
    expect(refusals).toBeLessThanOrEqual(12);
    expect((await load(dead.id)).isActive).toBe(true);
  });

  it("counts a soft-demoted key that served nothing since as dead in the key lifespan estimate when it is replaced", async () => {
    const { key } = await softDemotedOnTwo();
    await db.updateProviderConnection(key.id, { apiKey: "sk-test-a-replaced-0123456789" });
    expect((await load(key.id)).pastKeys).toEqual([{ since: expect.any(String), until: new Date().toISOString() }]);
  });

  // As the turn-off rule, which needs two models (or 401s in a row).
  it("doesn't count a key refused for itself on one model only as dead", async () => {
    const { key } = await softDemoted();
    await db.updateProviderConnection(key.id, { apiKey: "sk-test-a-replaced-0123456789" });
    expect((await load(key.id)).pastKeys).toBeUndefined();
  });

  it("doesn't count a key soft-demoted on one model that serves another", async () => {
    const { key } = await softDemoted();
    vi.advanceTimersByTime(MIN);
    await succeed(key.id, KIMI);
    await db.updateProviderConnection(key.id, { apiKey: "sk-test-a-replaced-0123456789" });
    expect((await load(key.id)).pastKeys).toBeUndefined();
  });

  it("stores a refused try, so a restart keeps its next wait", async () => {
    const { key, peer } = await softDemoted();
    vi.advanceTimersByTime(10 * MIN);
    expect(await pick(OPUS)).toBe(key.id);
    await succeed(peer.id, OPUS);
    await failOnce(key.id, OPUS);
    expect((await load(key.id))[`authSoft_${OPUS}`]).toMatchObject({
      level: 1, tryAt: new Date(Date.now() + 20 * MIN).toISOString(), lastRefusedAt: new Date().toISOString(),
    });
    global._softDemotions.clear();
    vi.advanceTimersByTime(19 * MIN);
    expect(await pick(OPUS)).toBe(peer.id);
    vi.advanceTimersByTime(MIN);
    expect(await pick(OPUS)).toBe(key.id);
  });


  it("soft-demotes a key refused on a model only its far peer serves, its near peer lacking it", async () => {
    const [key, near] = await accounts(["k", "near"], { shared: true });
    const [far] = await accounts(["far"]);
    for (let i = 0; i < 6; i++) {
      if (i > 0) vi.advanceTimersByTime(2 * MIN);
      await failOnce(near.id, OPUS);
      await succeed(far.id, OPUS);
      await failOnce(key.id, OPUS);
    }
    expect(auth.__test__.softDemoted(await load(key.id), OPUS)).toBe(true);
  });

  it("marks a soft demotion for refusals of just that model, and keeps it out of the key lifespan estimate", async () => {
    const [key, peer] = await accounts(["a", "b"]);
    const lacks = `[403]: {"error":{"message":"Your organization does not have access to model ${OPUS}"}}`;
    for (let i = 0; i < 6; i++) {
      if (i > 0) vi.advanceTimersByTime(2 * MIN);
      await succeed(peer.id, OPUS);
      await auth.markAccountUnavailable(key.id, 403, lacks, provider, OPUS);
    }
    expect((await load(key.id))[`authSoft_${OPUS}`]).toMatchObject({ keyRefused: false });
    await db.updateProviderConnection(key.id, { apiKey: "sk-test-a-replaced-0123456789" });
    expect((await load(key.id)).pastKeys).toBeUndefined();
  });

  it("doesn't soft-demote a key pasted in while the refusal that would was on its way", async () => {
    const [key, peer] = await accounts(["a", "b"]);
    await refuse(key.id, peer, { times: 5 });
    vi.advanceTimersByTime(2 * MIN);
    await succeed(peer.id, OPUS);
    beforeProxyLookup(() => db.updateProviderConnection(key.id, { apiKey: "sk-test-a-pasted-0123456789" }));
    await failOnce(key.id, OPUS, "sk-test-a-0123456789");
    const conn = await load(key.id);
    expect(conn.apiKey).toBe("sk-test-a-pasted-0123456789");
    expect(conn[`authSoft_${OPUS}`] ?? null).toBeNull();
    expect(conn.authDemoteOkAt ?? null).toBeNull();
    vi.advanceTimersByTime(3 * MIN);
    expect(await pick(OPUS)).toBe(key.id);
  });

  it.each([
    ["a refused soft try", async (key, peer) => {
      vi.advanceTimersByTime(10 * MIN);
      expect(await pick(OPUS)).toBe(key.id);
      await succeed(peer.id, OPUS);
      return OPUS;
    }],
    ["a refusal on another model, which makes the try due", async (key, peer) => {
      vi.advanceTimersByTime(3 * MIN);
      await succeed(peer.id, KIMI);
      return KIMI;
    }],
  ])("gives a key pasted in while %s was on its way no soft demotion", async (_label, setUp) => {
    const { key, peer } = await softDemoted();
    const model = await setUp(key, peer);
    beforeProxyLookup(() => db.updateProviderConnection(key.id, { apiKey: "sk-test-a-pasted-0123456789" }));
    await failOnce(key.id, model, "sk-test-a-0123456789");
    const conn = await load(key.id);
    expect(conn.apiKey).toBe("sk-test-a-pasted-0123456789");
    expect(conn[`authSoft_${OPUS}`] ?? null).toBeNull();
  });

  it("leaves a demotion the pasted key got alone when the refusal that would soft-demote the old one lands", async () => {
    const [key, peer] = await accounts(["a", "b"]);
    await refuse(key.id, peer, { times: 5 });
    vi.advanceTimersByTime(2 * MIN);
    await succeed(peer.id, OPUS);
    beforeProxyLookup(async () => {
      await db.updateProviderConnection(key.id, { apiKey: "sk-test-a-pasted-0123456789" });
      await db.updateProviderConnection(key.id, { [`authDemote_${OPUS}`]: { count: 1, firstAt: new Date().toISOString() } });
    });
    await failOnce(key.id, OPUS, "sk-test-a-0123456789");
    // That refusal would soft-demote the old key, lifting its count.
    expect(logged.warn).toContain(`AUTH a soft-demoted on ${OPUS} after repeated 403s`);
    expect((await load(key.id))[`authDemote_${OPUS}`]).toMatchObject({ count: 1 });
  });

  it("sends the soft demotion to the dashboard", async () => {
    const { key } = await softDemoted();
    const providers = await import("@/app/api/providers/route.js");
    const { connections } = await (await providers.GET()).json();
    expect(connections.find((c) => c.id === key.id)[`authSoft_${OPUS}`]).toMatchObject({ keyRefused: true });
  });

  it("counts a key switched off and then replaced while soft-demoted as dead in the key lifespan estimate", async () => {
    const { key } = await softDemotedOnTwo();
    await db.updateProviderConnection(key.id, { isActive: false });
    await db.updateProviderConnection(key.id, { apiKey: "sk-test-a-replaced-0123456789" });
    expect((await load(key.id)).pastKeys).toEqual([{ since: expect.any(String), until: new Date().toISOString() }]);
  });

  it("starts the key afresh when its soft-demoted model's cooldown is cleared", async () => {
    const { key, peer } = await softDemoted();
    await refuse(key.id, peer, { times: 3, model: KIMI });
    expect((await load(key.id))[`authDemote_${KIMI}`]).toMatchObject({ count: 3 });
    await availability.POST(new Request("http://localhost/api/models/availability", {
      method: "POST", body: JSON.stringify({ action: "clearCooldown", provider, model: OPUS }),
    }));
    const conn = await load(key.id);
    expect(conn[`authDemote_${KIMI}`] ?? null).toBeNull();
    expect(conn[`authSoft_${OPUS}`] ?? null).toBeNull();
  });

  it("ends its soft demotions on every model when one's cooldown is cleared", async () => {
    const { key, peer } = await softDemotedOnTwo();
    expect((await load(key.id))[`authSoft_${KIMI}`]).toMatchObject({ keyRefused: true });
    await availability.POST(new Request("http://localhost/api/models/availability", {
      method: "POST", body: JSON.stringify({ action: "clearCooldown", provider, model: OPUS }),
    }));
    expect((await load(key.id))[`authSoft_${KIMI}`] ?? null).toBeNull();
    expect(global._softDemotions.has(`${key.id}|${KIMI}`)).toBe(false);
    // Not held: a refusal a day on builds a streak, and nothing turns the key off.
    vi.advanceTimersByTime(25 * 60 * MIN);
    await succeed(peer.id, OPUS);
    await failOnce(key.id, OPUS);
    const conn = await load(key.id);
    expect(conn).toMatchObject({ isActive: true, authFailCount: 1 });
  });

  it("leaves a soft demotion a success lifted while a refusal was on its way", async () => {
    const { key, peer } = await softDemoted();
    vi.advanceTimersByTime(11 * MIN);
    await succeed(peer.id, OPUS);
    beforeProxyLookup(() => succeed(key.id, OPUS));
    await failOnce(key.id, OPUS);
    expect((await load(key.id))[`authSoft_${OPUS}`] ?? null).toBeNull();
  });

  it("doesn't soft-demote over a soft demotion written while the entering refusal was on its way", async () => {
    const [key, peer] = await accounts(["a", "b"]);
    await refuse(key.id, peer, { times: 5 });
    vi.advanceTimersByTime(2 * MIN);
    await succeed(peer.id, OPUS);
    const other = { level: 3, since: "2026-11-12T00:00:00.000Z", tryAt: "2026-11-12T01:00:00.000Z", lastRefusedAt: "2026-11-12T00:00:00.000Z", keyRefused: true };
    beforeProxyLookup(() => db.updateProviderConnection(key.id, { [`authSoft_${OPUS}`]: other }));
    await failOnce(key.id, OPUS);
    expect((await load(key.id))[`authSoft_${OPUS}`]).toEqual(other);
  });

  const clearOpus = (route = availability) => route.POST(new Request("http://localhost/api/models/availability", {
    method: "POST", body: JSON.stringify({ action: "clearCooldown", provider, model: OPUS }),
  }));

  it("keeps the key's other counts when the cleared soft demotion was for a model it lacks", async () => {
    const [key, peer] = await accounts(["a", "b"]);
    const lacks = `[403]: {"error":{"message":"Your organization does not have access to model ${OPUS}"}}`;
    for (let i = 0; i < 6; i++) {
      if (i > 0) vi.advanceTimersByTime(2 * MIN);
      await succeed(peer.id, OPUS);
      await auth.markAccountUnavailable(key.id, 403, lacks, provider, OPUS);
    }
    expect((await load(key.id))[`authSoft_${OPUS}`]).toMatchObject({ keyRefused: false });
    await refuse(key.id, peer, { times: 3, model: KIMI });
    const before = await load(key.id);
    expect(before.authFailCount).toBe(3);
    await clearOpus();
    const conn = await load(key.id);
    expect(conn[`authSoft_${OPUS}`] ?? null).toBeNull();
    expect(conn.authFailCount).toBe(3);
    expect(conn[`authDemote_${KIMI}`]).toEqual(before[`authDemote_${KIMI}`]);
  });

  it("keeps the key's other counts when its cooldown is cleared with AUTH_SOFT_DEMOTE=0", async () => {
    const { key, peer } = await softDemoted();
    await refuse(key.id, peer, { times: 3, model: KIMI });
    vi.stubEnv("AUTH_SOFT_DEMOTE", "0");
    vi.resetModules();
    const freshDb = await import("@/lib/db/index.js");
    await clearOpus(await import("@/app/api/models/availability/route.js"));
    expect((await freshDb.getProviderConnectionById(key.id))[`authDemote_${KIMI}`]).toMatchObject({ count: 3 });
  });

  it("still turns off a key soft-demoted only on a model it lacks", async () => {
    const [key, near] = await accounts(["k", "near"], { shared: true });
    const [far] = await accounts(["far"]);
    const lacks = `[403]: {"error":{"message":"Your organization does not have access to model ${OPUS}"}}`;
    for (let i = 0; i < 6; i++) {
      if (i > 0) vi.advanceTimersByTime(2 * MIN);
      await succeed(far.id, OPUS);
      await auth.markAccountUnavailable(key.id, 403, lacks, provider, OPUS);
    }
    expect((await load(key.id))[`authSoft_${OPUS}`]).toMatchObject({ keyRefused: false });
    for (let i = 0; i < 12 && (await load(key.id)).isActive; i++) {
      vi.advanceTimersByTime(2 * MIN);
      await refuse(key.id, near, { times: 1, model: i % 2 ? KIMI : "claude-sonnet-5-5" });
    }
    expect((await load(key.id)).isActive).toBe(false);
  });

  it("ends on that model when its cooldown is cleared", async () => {
    const { key, peer } = await softDemoted();
    vi.advanceTimersByTime(3 * MIN);
    expect(await pick(OPUS)).toBe(peer.id);
    const res = await availability.POST(new Request("http://localhost/api/models/availability", {
      method: "POST", body: JSON.stringify({ action: "clearCooldown", provider, model: OPUS }),
    }));
    expect(res.status).toBe(200);
    expect(await pick(OPUS)).toBe(key.id);
  });
});

describe("after a long soft demotion", () => {
  // `models(m)` each minute for `hours` (opus alone, or with kimi every 9
  // minutes), the key refused on them; `onMinute(m)` runs first each minute.
  // The minute the key went off (from soft entry), or null, and its refusals.
  const OPUS_ONLY = () => [OPUS];
  const WITH_KIMI = (m) => (m % 9 === 0 ? [OPUS, KIMI] : [OPUS]);
  async function run(key, hours, onMinute = async () => {}, models = WITH_KIMI) {
    let refusals = 0;
    for (let m = 1; m <= hours * 60; m++) {
      vi.advanceTimersByTime(MIN);
      await onMinute(m);
      for (const model of models(m)) {
        const tried = new Set();
        for (;;) {
          const creds = await auth.getProviderCredentials(provider, tried, model);
          if (!creds?.connectionId) break;
          if (creds.connectionId !== key.id) {
            await succeed(creds.connectionId, model);
            break;
          }
          refusals++;
          await failOnce(key.id, model);
          tried.add(key.id);
        }
      }
      if (!(await load(key.id)).isActive) return { off: m, refusals };
    }
    return { off: null, refusals };
  }

  it("turns off a key refused for itself on two models, at its first refusal after 24 hours", async () => {
    const { key } = await softDemoted();
    const { off, refusals } = await run(key, 30);
    expect(off).toBeGreaterThanOrEqual(24 * 60);
    expect(off).toBeLessThanOrEqual(24 * 60 + 180);
    expect(refusals).toBeGreaterThanOrEqual(6);
    const conn = await load(key.id);
    expect(conn.autoDisabledAt).toBe(new Date().toISOString());
    expect(conn.autoDisabledReason).toMatch(new RegExp(`^403 "Key barred from this endpoint" on (${OPUS}, ${KIMI}|${KIMI}, ${OPUS}) for 24h while soft-demoted$`));
    // A key lifespan sample, as for any key turned off automatically.
    await db.updateProviderConnection(key.id, { apiKey: "sk-test-a-replaced-0123456789" });
    expect((await load(key.id)).pastKeys).toEqual([{ since: expect.any(String), until: conn.autoDisabledAt }]);
  });

  // As master leaves on a key refused on one model only (it needs minModels).
  it("keeps a key on that is refused for itself on one model only", async () => {
    const { key } = await softDemoted();
    const { off, refusals } = await run(key, 48, undefined, OPUS_ONLY);
    expect(off).toBeNull();
    expect(refusals).toBeGreaterThanOrEqual(6);
  }, 120000);

  // The reviewer's replay: refused on opus alone, it serves sonnet whenever
  // asked, until sonnet goes idle.
  it.each([
    ["every 5 minutes for 2 hours", 120, 5],
    ["every 5 minutes for 12 hours", 720, 5],
    ["every 30 minutes for 20 hours", 1200, 30],
  ])("keeps a key on that serves sonnet %s, then sonnet goes idle", async (_label, idleFrom, every) => {
    const [key] = await accounts(["k", "peer"]);
    let off = null, served = 0;
    for (let m = 0; m < 48 * 60 && off === null; m++) {
      if (m > 0) vi.advanceTimersByTime(MIN);
      await request(OPUS, (id) => id === key.id);
      if (m < idleFrom && m % every === 0 && await request("claude-sonnet-5-5", () => false) === key.id) served++;
      if (!(await load(key.id)).isActive) off = m;
    }
    expect(served).toBeGreaterThan(0);
    expect((await load(key.id))[`authSoft_${OPUS}`]).toMatchObject({ keyRefused: true });
    expect(off).toBeNull();
  }, 120000);

  it("keeps a key on that serves anything in that time", async () => {
    const { key } = await softDemoted();
    const { off } = await run(key, 30, async (m) => { if (m === 12 * 60) await succeed(key.id, KIMI); });
    expect(off).toBeNull();
  });

  it("keeps a key on that is soft-demoted only on a model it lacks", async () => {
    const [key, peer] = await accounts(["a", "b"]);
    const lacks = `[403]: {"error":{"message":"Your organization does not have access to model ${OPUS}"}}`;
    for (let i = 0; i < 6; i++) {
      if (i > 0) vi.advanceTimersByTime(2 * MIN);
      await succeed(peer.id, OPUS);
      await auth.markAccountUnavailable(key.id, 403, lacks, provider, OPUS);
    }
    expect((await load(key.id))[`authSoft_${OPUS}`]).toMatchObject({ keyRefused: false });
    const { off } = await run(key, 30, undefined, OPUS_ONLY);
    expect(off).toBeNull();
  });

  it("keeps a key on with AUTH_SOFT_DEMOTE_DEAD_AFTER_MS=0", async () => {
    vi.stubEnv("AUTH_SOFT_DEMOTE_DEAD_AFTER_MS", "0");
    vi.resetModules();
    const freshDb = await import("@/lib/db/index.js");
    const freshAuth = await import("@/sse/services/auth.js");
    const keys = [];
    for (const name of ["a", "b"]) {
      keys.push(await freshDb.createProviderConnection({
        provider, authType: "apikey", name, apiKey: `sk-test-${name}-0123456789`,
        providerSpecificData: { baseUrl: `https://acct-${name}.acme.test/v1`, ownBaseUrl: true },
      }));
    }
    const [key, peer] = keys;
    const ok = async (id, model) => freshAuth.clearAccountError(id, await freshDb.getProviderConnectionById(id), model);
    // Refused on opus, then once soft-demoted there on kimi too, which turns
    // the key off a day on with the default (see above).
    for (let m = 0; m < 30 * 60; m++) {
      if (m > 0) vi.advanceTimersByTime(MIN);
      for (const model of m < 20 ? [OPUS] : WITH_KIMI(m)) {
        const tried = new Set();
        for (;;) {
          const creds = await freshAuth.getProviderCredentials(provider, tried, model);
          if (!creds?.connectionId) break;
          if (creds.connectionId !== key.id) {
            await ok(creds.connectionId, model);
            break;
          }
          if (m === 0) await ok(peer.id, model);
          await freshAuth.markAccountUnavailable(key.id, 403, REFUSED_403, provider, model);
          tried.add(key.id);
        }
      }
    }
    const conn = await freshDb.getProviderConnectionById(key.id);
    expect(conn[`authSoft_${OPUS}`]).toBeTruthy();
    expect(conn.isActive).toBe(true);
  });

  // One request for `model`: keys in routing order until one serves, those
  // `refused(id)` refused. The key that served, or null.
  async function request(model, refused, a = auth) {
    const tried = new Set();
    for (;;) {
      const creds = await a.getProviderCredentials(provider, tried, model);
      if (!creds?.connectionId) return null;
      if (!refused(creds.connectionId)) {
        await a.clearAccountError(creds.connectionId, creds, model);
        return creds.connectionId;
      }
      await a.markAccountUnavailable(creds.connectionId, 403, REFUSED_403, provider, model);
      tried.add(creds.connectionId);
    }
  }

  const SONNET = "claude-sonnet-5-5";
  // Own: the key and its peer on their own accounts. Mixed: the key and a near
  // peer, refused on opus too, on one account; a far peer on another.
  it.each(["own", "mixed"])("turns off a key that served sonnet while soft-demoted on opus, then died, a day after its last success (%s)", async (layout) => {
    const [key, near] = layout === "own" ? await accounts(["k", "peer"]) : await accounts(["k", "near"], { shared: true });
    if (layout === "mixed") await accounts(["far"]);
    const DIES = 180;
    let softAt = null, lastServed = null, off = null;
    for (let m = 0; m < 48 * 60 && off === null; m++) {
      if (m > 0) vi.advanceTimersByTime(MIN);
      for (const model of m % 9 === 0 ? [OPUS, SONNET] : [OPUS]) {
        const served = await request(model, (id) => (id === key.id ? model === OPUS || m >= DIES : layout === "mixed" && id === near.id && model === OPUS));
        if (served === key.id) lastServed = m;
      }
      const conn = await load(key.id);
      if (softAt === null && conn[`authSoft_${OPUS}`]?.since) softAt = m;
      if (!conn.isActive) off = m;
    }
    expect(softAt).toBeLessThanOrEqual(15);
    expect(lastServed).toBeGreaterThanOrEqual(DIES - 9);
    expect(off).toBeGreaterThanOrEqual(lastServed + 24 * 60);
    expect(off).toBeLessThanOrEqual(lastServed + 24 * 60 + 180);
  }, 120000);

  it("doesn't restart the day when the key is soft-demoted on a second model", async () => {
    const { key, peer } = await softDemoted();
    vi.advanceTimersByTime(20 * 60 * MIN);
    await refuse(key.id, peer, { times: 6, model: KIMI });
    expect((await load(key.id))[`authSoft_${KIMI}`]).toMatchObject({ keyRefused: true });
    // A day from the opus demotion is about 4 hours on; from kimi's, 24.
    const { off } = await run(key, 12, undefined, OPUS_ONLY);
    expect(off).not.toBeNull();
    expect(off).toBeLessThanOrEqual(4 * 60 + 2 * 180);
    expect((await load(key.id)).autoDisabledReason).toBe(`403 "Key barred from this endpoint" on ${OPUS}, ${KIMI} for 24h while soft-demoted`);
  });

  it("turns it off at a refusal, not at an upstream error", async () => {
    const { key, peer } = await softDemoted();
    // Refused for itself on opus and kimi, so only the trigger is missing.
    expect((await run(key, 23)).off).toBeNull();
    vi.advanceTimersByTime(2 * 60 * MIN);
    await auth.markAccountUnavailable(key.id, 500, "Internal server error", provider, KIMI);
    expect((await load(key.id)).isActive).toBe(true);
    await succeed(peer.id, KIMI);
    await failOnce(key.id, KIMI);
    expect((await load(key.id)).isActive).toBe(false);
  });

  // 401s count toward the day rule only in a row (5, as master's all-401 streak).
  it("turns it off at the fifth 401 in a row on another model, once the day is up", async () => {
    const { key, peer } = await softDemoted();
    expect((await run(key, 25, undefined, OPUS_ONLY)).off).toBeNull();
    for (let i = 1; i <= 5; i++) {
      vi.advanceTimersByTime(3 * MIN);
      await succeed(peer.id, KIMI);
      await auth.markAccountUnavailable(key.id, 401, "Invalid API key", provider, KIMI);
      expect([i, (await load(key.id)).isActive]).toEqual([i, i < 5]);
    }
    expect((await load(key.id)).autoDisabledReason).toBe(`401 "Invalid API key" on ${OPUS}, ${KIMI} for 24h while soft-demoted`);
  }, 120000);

  // The reviewer's replay: refused on opus with 403s (as if it lacked it),
  // kimi idle for 27 hours, then a refusal or two of the key on kimi.
  it.each([
    ["one 401", [[401, "Invalid API key"]]],
    ["two 401s", [[401, "Invalid API key"], [401, "Invalid API key"]]],
  ])("keeps a key on refused on opus for a day, then refused with %s on kimi", async (_label, refusals) => {
    const [key, peer] = await accounts(["k", "peer"]);
    const pending = [...refusals];
    let off = null;
    for (let m = 0; m < 27 * 60 + 240 && off === null; m++) {
      if (m > 0) vi.advanceTimersByTime(MIN);
      await requestAnswered(OPUS, (id) => (id === key.id ? [403, REFUSED_403] : null));
      // The peer serves kimi first, so the key's refusals there count.
      if (m === 27 * 60) await succeed(peer.id, KIMI);
      if (m >= 27 * 60) {
        for (let i = 0; i < 2; i++) await requestAnswered(KIMI, (id) => (id === key.id && pending.length ? pending.shift() : null));
      }
      if (!(await load(key.id)).isActive) off = m;
    }
    expect(pending).toEqual([]);
    expect(off).toBeNull();
  }, 120000);

  // One request: keys in routing order until one serves; answer(id) is
  // [status, text] for a refusal, or null.
  async function requestAnswered(model, answer) {
    const tried = new Set();
    for (;;) {
      const creds = await auth.getProviderCredentials(provider, tried, model);
      if (!creds?.connectionId) return null;
      const a = answer(creds.connectionId);
      if (!a) {
        await auth.clearAccountError(creds.connectionId, creds, model);
        return creds.connectionId;
      }
      await auth.markAccountUnavailable(creds.connectionId, a[0], a[1], provider, model);
      tried.add(creds.connectionId);
    }
  }

  // Refusals of just the model ("does not have access") on a model the key is
  // soft-demoted on for itself: refused tries, but not of the key.
  const lacksText = (m) => `[403]: {"error":{"message":"Your organization does not have access to model ${m}"}}`;
  async function requestWith(model, textFor) {
    const tried = new Set();
    for (;;) {
      const creds = await auth.getProviderCredentials(provider, tried, model);
      if (!creds?.connectionId) return null;
      const text = textFor(creds.connectionId);
      if (!text) {
        await auth.clearAccountError(creds.connectionId, creds, model);
        return creds.connectionId;
      }
      await auth.markAccountUnavailable(creds.connectionId, 403, text, provider, model);
      tried.add(creds.connectionId);
    }
  }

  it("doesn't count a soft try refused for just that model as a refusal of the key", async () => {
    const { key, peer } = await softDemoted();
    vi.advanceTimersByTime(11 * MIN);
    await succeed(peer.id, OPUS);
    await failOnce(key.id, OPUS);
    const keyRefusedAt = new Date().toISOString();
    vi.advanceTimersByTime(21 * MIN);
    await succeed(peer.id, OPUS);
    await auth.markAccountUnavailable(key.id, 403, lacksText(OPUS), provider, OPUS);
    const rec = (await load(key.id))[`authSoft_${OPUS}`];
    expect(rec).toMatchObject({ level: 2, lastRefusedAt: new Date().toISOString(), tries: 1, keyRefusedAt });
  });

  // A 401: the key revoked once its budget ran out.
  it("counts a 401 as a refused try, on the probe schedule", async () => {
    const { key, peer } = await softDemoted();
    vi.advanceTimersByTime(11 * MIN);
    await succeed(peer.id, OPUS);
    await auth.markAccountUnavailable(key.id, 401, "Invalid API key", provider, OPUS);
    const rec = (await load(key.id))[`authSoft_${OPUS}`];
    // A 401 is no refusal on a second model for the day rule: keyRefusedAt stays.
    expect(rec).toMatchObject({ level: 1, tries: 1, keyRefusedAt: rec.since, tryAt: new Date(Date.now() + 20 * MIN).toISOString() });
  });

  // Soft-demoted for a model it lacks, the key isn't held: its 401s leave the
  // try due, so the turn-off rule sees them as master would.
  it("turns off a key soft-demoted for a model it lacks, then revoked, within about an hour, opus only", async () => {
    const [key] = await accounts(["a", "b"]);
    let text = lacksText(OPUS);
    let revokedAt = null, off = null;
    for (let m = 0; m < 6 * 60 && off === null; m++) {
      if (m > 0) vi.advanceTimersByTime(MIN);
      const tried = new Set();
      for (;;) {
        const creds = await auth.getProviderCredentials(provider, tried, OPUS);
        if (!creds?.connectionId) break;
        if (creds.connectionId !== key.id) {
          await auth.clearAccountError(creds.connectionId, creds, OPUS);
          break;
        }
        if (text === "401") await auth.markAccountUnavailable(key.id, 401, "Invalid API key", provider, OPUS);
        else await auth.markAccountUnavailable(key.id, 403, text, provider, OPUS);
        tried.add(key.id);
      }
      if (revokedAt === null && (await load(key.id))[`authSoft_${OPUS}`]?.keyRefused === false) {
        revokedAt = m;
        text = "401";
      }
      if (!(await load(key.id)).isActive) off = m;
    }
    expect(revokedAt).not.toBeNull();
    expect(off).not.toBeNull();
    expect(off - revokedAt).toBeLessThanOrEqual(90);
  });

  it("counts a held key's 401s in a row, until another refusal of the key or a success", async () => {
    const { key, peer } = await softDemoted();
    const tryOpus = async (status, text) => {
      vi.advanceTimersByTime(200 * MIN);
      await succeed(peer.id, OPUS);
      await auth.markAccountUnavailable(key.id, status, text, provider, OPUS);
      return (await load(key.id)).authHeld401s ?? null;
    };
    expect(await tryOpus(401, "Invalid API key")).toBe(1);
    expect(await tryOpus(401, "Invalid API key")).toBe(2);
    expect(await tryOpus(403, REFUSED_403)).toBeNull();
    expect(await tryOpus(401, "Invalid API key")).toBe(1);
    await succeed(key.id, KIMI);
    expect((await load(key.id)).authHeld401s ?? null).toBeNull();
  });

  // Master's streak turns a key refused only with 401s off on one model.
  it("turns off a key soft-demoted on opus only whose 403s turn into 401s, a day after its soft demotion", async () => {
    const [key] = await accounts(["k", "peer"]);
    let softAt = null, off = null;
    for (let m = 0; m < 48 * 60 && off === null; m++) {
      if (m > 0) vi.advanceTimersByTime(MIN);
      const tried = new Set();
      for (;;) {
        const creds = await auth.getProviderCredentials(provider, tried, OPUS);
        if (!creds?.connectionId) break;
        if (creds.connectionId !== key.id) {
          await auth.clearAccountError(creds.connectionId, creds, OPUS);
          break;
        }
        if (m >= 180) await auth.markAccountUnavailable(key.id, 401, "Invalid API key", provider, OPUS);
        else await failOnce(key.id, OPUS);
        tried.add(key.id);
      }
      const conn = await load(key.id);
      if (softAt === null && conn[`authSoft_${OPUS}`]?.since) softAt = m;
      if (!conn.isActive) off = m;
    }
    expect(off).toBeGreaterThanOrEqual(softAt + 24 * 60);
    expect(off).toBeLessThanOrEqual(softAt + 24 * 60 + 180);
    expect((await load(key.id)).autoDisabledReason).toBe(`401 "Invalid API key" on ${OPUS} for 24h while soft-demoted`);
  }, 120000);

  it("stores a success right after a refusal of the key itself, within the minute", async () => {
    const { key, peer } = await softDemoted();
    vi.advanceTimersByTime(11 * MIN);
    await succeed(key.id, KIMI);
    vi.advanceTimersByTime(10 * 1000);
    await succeed(peer.id, OPUS);
    await failOnce(key.id, OPUS);
    vi.advanceTimersByTime(10 * 1000);
    global._authEvents.softKeys.delete(key.id);
    await succeed(key.id, KIMI);
    expect((await load(key.id)).authServedAt).toBe(new Date().toISOString());
  });

  it("stores a success right after a 401 on a soft-demoted model, within the minute", async () => {
    const { key, peer } = await softDemoted();
    vi.advanceTimersByTime(11 * MIN);
    await succeed(key.id, KIMI);
    vi.advanceTimersByTime(10 * 1000);
    await succeed(peer.id, OPUS);
    await auth.markAccountUnavailable(key.id, 401, "Invalid API key", provider, OPUS);
    expect((await load(key.id))[`authSoft_${OPUS}`]).toMatchObject({ level: 1, tries: 1 });
    vi.advanceTimersByTime(10 * 1000);
    global._authEvents.softKeys.delete(key.id);
    await succeed(key.id, KIMI);
    expect((await load(key.id)).authServedAt).toBe(new Date().toISOString());
  });

  // The reviewers' sequence: 403s on opus, one 403 then 401s on kimi more than
  // 10 minutes apart (so kimi's soft demotion began with a 403 its 401s
  // completed), a success on sonnet, then the same every `period` minutes.
  // Master leaves the key on; 401s on kimi don't make it a second model.
  it.each([[22], [30]])("keeps a key on refused on opus with 403s and on kimi with 401s, every %i minutes", async (period) => {
    const [key, peer] = await accounts(["k", "peer"]);
    for (const model of [OPUS, KIMI]) await succeed(peer.id, model);
    const schedule = new Map();
    const add = (m, model, answer) => schedule.set(m, [...(schedule.get(m) || []), [model, answer]]);
    for (const m of [0, 11, 22, 33, 44]) add(m, OPUS, [403, REFUSED_403]);
    add(55, KIMI, [403, REFUSED_403]);
    add(60, "claude-sonnet-5-5", null);
    for (const m of [71, 82, 93, 104]) add(m, KIMI, [401, "Invalid API key"]);
    for (let m = 115; m < 48 * 60; m += period) {
      add(m, OPUS, [403, REFUSED_403]);
      add(m + Math.floor(period / 2), KIMI, [401, "Invalid API key"]);
    }
    let last = 0;
    for (const m of [...schedule.keys()].sort((a, b) => a - b)) {
      vi.advanceTimersByTime((m - last) * MIN);
      last = m;
      if (m === 55) await succeed(peer.id, KIMI);
      for (const [model, answer] of schedule.get(m)) await requestAnswered(model, (id) => (id === key.id ? answer : null));
      expect([m, (await load(key.id)).isActive]).toEqual([m, true]);
    }
    expect((await load(key.id))[`authSoft_${KIMI}`]).toMatchObject({ keyRefused: true });
  }, 120000);

  // The reviewer's replay: refused with 403s, soft-demoted on opus, then 401s
  // on every model from `switchAt` (kimi served by the key before that, or not
  // asked for).
  it.each([[30, false, `${OPUS}, ${KIMI}`], [30, true, OPUS], [180, true, OPUS]])("turns off a key refused with 403s, then 401s on every model from minute %i (kimi served before: %s), a day after its last success", async (switchAt, kimiServes, reasonModels) => {
    const [key] = await accounts(["k", "peer"]);
    let off = null, lastServed = null, refusals = 0;
    for (let m = 0; m < 48 * 60 && off === null; m++) {
      if (m > 0) vi.advanceTimersByTime(MIN);
      for (const model of (m < switchAt && !kimiServes ? [OPUS] : [OPUS, KIMI])) {
        const tried = new Set();
        for (;;) {
          const creds = await auth.getProviderCredentials(provider, tried, model);
          if (!creds?.connectionId) break;
          if (creds.connectionId !== key.id || (kimiServes && model === KIMI && m < switchAt)) {
            await auth.clearAccountError(creds.connectionId, creds, model);
            if (creds.connectionId === key.id) lastServed = m;
            break;
          }
          refusals++;
          if (m >= switchAt) await auth.markAccountUnavailable(key.id, 401, "Invalid API key", provider, model);
          else await failOnce(key.id, model);
          tried.add(key.id);
        }
      }
      if (!(await load(key.id)).isActive) off = m;
    }
    const from = Math.max(12, lastServed ?? -Infinity);
    expect(off).toBeGreaterThanOrEqual(from + 24 * 60);
    expect(off).toBeLessThanOrEqual(from + 24 * 60 + 180);
    // Tried on the probe schedule on both models, not first on kimi all day.
    expect(refusals).toBeLessThanOrEqual(60);
    // By 401s in a row: the models refused other than with 401s since the last success, and this one.
    expect((await load(key.id)).autoDisabledReason).toBe(`401 "Invalid API key" on ${reasonModels} for 24h while soft-demoted`);
  }, 120000);

  // Mutations: the two-model check reading lastRefusedAt, the rule checked at
  // a soft try refused for just that model, and tries counted from `level`.
  it("keeps a key on refused for itself on opus only since its last success, kimi refusing just that model", async () => {
    const [key] = await accounts(["k", "peer"]);
    let lacks = false;
    const textFor = (model) => (id) => (id !== key.id ? null : lacks && model === KIMI ? lacksText(model) : REFUSED_403);
    for (let m = 0; m < 40; m++) {
      if (m > 0) vi.advanceTimersByTime(MIN);
      await requestWith(OPUS, textFor(OPUS));
    }
    vi.advanceTimersByTime(3 * 60 * MIN);
    for (let m = 0; m < 40; m++) {
      vi.advanceTimersByTime(MIN);
      await requestWith(KIMI, textFor(KIMI));
    }
    expect((await load(key.id))[`authSoft_${KIMI}`]).toMatchObject({ keyRefused: true });
    vi.advanceTimersByTime(MIN);
    expect(await requestWith("claude-sonnet-5-5", () => null)).toBe(key.id);
    lacks = true;
    let off = null;
    for (let m = 0; m < 30 * 60 && off === null; m++) {
      vi.advanceTimersByTime(MIN);
      await requestWith(OPUS, textFor(OPUS));
      if (m % 7 === 0) await requestWith(KIMI, textFor(KIMI));
      if (!(await load(key.id)).isActive) off = m;
    }
    expect((await load(key.id))[`authSoft_${OPUS}`].tries).toBeGreaterThanOrEqual(6);
    expect(off).toBeNull();
  }, 120000);

  it("keeps a key on whose only refusal on a second model is a soft try for a model it lacks", async () => {
    const { key, peer } = await softDemoted();
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(2 * MIN);
      await succeed(peer.id, KIMI);
      await auth.markAccountUnavailable(key.id, 403, lacksText(KIMI), provider, KIMI);
    }
    expect((await load(key.id))[`authSoft_${KIMI}`]).toMatchObject({ keyRefused: false });
    expect((await run(key, 25, undefined, OPUS_ONLY)).off).toBeNull();
    expect((await load(key.id))[`authSoft_${OPUS}`].tries).toBeGreaterThanOrEqual(6);
    vi.advanceTimersByTime(181 * MIN);
    await succeed(peer.id, KIMI);
    await auth.markAccountUnavailable(key.id, 403, lacksText(KIMI), provider, KIMI);
    expect((await load(key.id))[`authSoft_${KIMI}`].level).toBe(1);
    expect((await load(key.id)).isActive).toBe(true);
  }, 120000);

  it("keeps a key on whose soft tries were all refusals of just that model, refused for itself elsewhere after the day", async () => {
    const [key, peer] = await accounts(["k", "peer"]);
    let text = REFUSED_403;
    for (let m = 0; m < 40; m++) {
      if (m > 0) vi.advanceTimersByTime(MIN);
      await requestWith(OPUS, (id) => (id === key.id ? text : null));
      if ((await load(key.id))[`authSoft_${OPUS}`]) text = lacksText(OPUS);
    }
    for (let m = 0; m < 25 * 60; m++) {
      vi.advanceTimersByTime(MIN);
      await requestWith(OPUS, (id) => (id === key.id ? text : null));
    }
    const rec = (await load(key.id))[`authSoft_${OPUS}`];
    expect(rec).toMatchObject({ keyRefused: true });
    expect(rec.level).toBeGreaterThanOrEqual(6);
    expect(rec.tries ?? 0).toBe(0);
    vi.advanceTimersByTime(MIN);
    await succeed(peer.id, KIMI);
    await failOnce(key.id, KIMI);
    expect((await load(key.id)).isActive).toBe(true);
  }, 120000);

  it("keeps a key on whose soft tries after its last success were refusals of just that model, then refused for itself once elsewhere", async () => {
    const [key, peer] = await accounts(["k", "peer"]);
    let text = REFUSED_403;
    for (let m = 0; m < 40; m++) {
      if (m > 0) vi.advanceTimersByTime(MIN);
      await requestWith(OPUS, (id) => (id === key.id ? text : null));
    }
    expect((await load(key.id))[`authSoft_${OPUS}`]).toMatchObject({ keyRefused: true });
    vi.advanceTimersByTime(MIN);
    expect(await requestWith("claude-sonnet-5-5", () => null)).toBe(key.id);
    text = lacksText(OPUS);
    for (let m = 0; m < 25 * 60; m++) {
      vi.advanceTimersByTime(MIN);
      await requestWith(OPUS, (id) => (id === key.id ? text : null));
    }
    expect((await load(key.id))[`authSoft_${OPUS}`].level).toBeGreaterThanOrEqual(6);
    vi.advanceTimersByTime(MIN);
    await succeed(peer.id, KIMI);
    await failOnce(key.id, KIMI);
    expect((await load(key.id)).isActive).toBe(true);
  }, 120000);

  it("keeps a key on soft-demoted for itself on two models whose tries after its last success are refusals of just those models", async () => {
    const [key] = await accounts(["k", "peer"]);
    let lacks = false;
    const textFor = (model) => (id) => (id !== key.id ? null : lacks ? lacksText(model) : REFUSED_403);
    for (let m = 0; m < 40; m++) {
      if (m > 0) vi.advanceTimersByTime(MIN);
      await requestWith(OPUS, textFor(OPUS));
    }
    vi.advanceTimersByTime(3 * 60 * MIN);
    for (let m = 0; m < 40; m++) {
      vi.advanceTimersByTime(MIN);
      await requestWith(KIMI, textFor(KIMI));
    }
    const conn = await load(key.id);
    expect(conn[`authSoft_${OPUS}`]).toMatchObject({ keyRefused: true });
    expect(conn[`authSoft_${KIMI}`]).toMatchObject({ keyRefused: true });
    vi.advanceTimersByTime(MIN);
    expect(await requestWith("claude-sonnet-5-5", () => null)).toBe(key.id);
    lacks = true;
    let off = null;
    for (let m = 0; m < 30 * 60 && off === null; m++) {
      vi.advanceTimersByTime(MIN);
      await requestWith(OPUS, textFor(OPUS));
      if (m % 7 === 0) await requestWith(KIMI, textFor(KIMI));
      if (!(await load(key.id)).isActive) off = m;
    }
    expect(off).toBeNull();
  }, 120000);

  it("counts only the tries since the key last served", async () => {
    const { key, peer } = await softDemoted();
    await run(key, 12, undefined, OPUS_ONLY);
    expect((await load(key.id))[`authSoft_${OPUS}`].level).toBeGreaterThanOrEqual(6);
    await succeed(key.id, "claude-sonnet-5-5");
    vi.advanceTimersByTime(25 * 60 * MIN);
    await succeed(peer.id, KIMI);
    await failOnce(key.id, KIMI);
    await succeed(peer.id, OPUS);
    await failOnce(key.id, OPUS);
    const conn = await load(key.id);
    expect(conn[`authSoft_${OPUS}`]).toMatchObject({ tries: 1 });
    expect(conn.isActive).toBe(true);
  }, 120000);

  it("keeps a key on that is tried too seldom in the day to tell", async () => {
    const { key, peer } = await softDemoted();
    vi.advanceTimersByTime(25 * 60 * MIN);
    await succeed(peer.id, OPUS);
    await failOnce(key.id, OPUS);
    const conn = await load(key.id);
    expect(conn[`authSoft_${OPUS}`]).toMatchObject({ level: 1 });
    expect(conn.isActive).toBe(true);
  });

  it("counts the day from the key's last success across a restart", async () => {
    const { key } = await softDemoted();
    vi.advanceTimersByTime(12 * 60 * MIN);
    await succeed(key.id, KIMI);
    const servedAt = Date.now();
    expect((await load(key.id)).authServedAt).toBe(new Date(servedAt).toISOString());
    const events = global._authEvents;
    try {
      delete global._authEvents;
      global._softDemotions.clear();
      vi.resetModules();
      const freshAuth = await import("@/sse/services/auth.js");
      const freshDb = await import("@/lib/db/index.js");
      let off = null;
      for (let m = 1; m <= 30 * 60 && off === null; m++) {
        vi.advanceTimersByTime(MIN);
        for (const model of WITH_KIMI(m)) await request(model, (id) => id === key.id, freshAuth);
        if (!(await freshDb.getProviderConnectionById(key.id)).isActive) off = Date.now() - servedAt;
      }
      expect(off).toBeGreaterThanOrEqual(24 * 60 * MIN);
      expect(off).toBeLessThanOrEqual((24 * 60 + 180) * MIN);
    } finally {
      global._authEvents = events;
    }
  }, 120000);

  it.each([
    ["1200000", "20m"],
    ["5400000", "90m"],
    ["90000", "90s"],
  ])("names the time it was given, %s ms as %s", async (ms, shown) => {
    vi.stubEnv("AUTH_SOFT_DEMOTE_DEAD_AFTER_MS", ms);
    vi.stubEnv("AUTH_SOFT_DEMOTE_DEAD_AFTER_TRIES", "1");
    vi.resetModules();
    const freshAuth = await import("@/sse/services/auth.js");
    const freshDb = await import("@/lib/db/index.js");
    const [key, peer] = await accounts(["a", "b"]);
    for (let i = 0; i < 6; i++) {
      if (i > 0) vi.advanceTimersByTime(2 * MIN);
      await freshAuth.clearAccountError(peer.id, await freshDb.getProviderConnectionById(peer.id), OPUS);
      await freshAuth.markAccountUnavailable(key.id, 403, REFUSED_403, provider, OPUS);
    }
    // Soft-demoted on kimi too, without a refused try there.
    for (let i = 0; i < 6; i++) {
      if (i > 0) vi.advanceTimersByTime(2 * MIN);
      await freshAuth.clearAccountError(peer.id, await freshDb.getProviderConnectionById(peer.id), KIMI);
      await freshAuth.markAccountUnavailable(key.id, 403, REFUSED_403, provider, KIMI);
    }
    expect((await freshDb.getProviderConnectionById(key.id))[`authSoft_${KIMI}`]).toMatchObject({ level: 0 });
    vi.advanceTimersByTime(Number(ms));
    await freshAuth.clearAccountError(peer.id, await freshDb.getProviderConnectionById(peer.id), OPUS);
    await freshAuth.markAccountUnavailable(key.id, 403, REFUSED_403, provider, OPUS);
    const conn = await freshDb.getProviderConnectionById(key.id);
    expect(conn.isActive).toBe(false);
    expect(conn.autoDisabledReason).toBe(`403 "Key barred from this endpoint" on ${OPUS}, ${KIMI} for ${shown} while soft-demoted`);
  });

  // Names the models refused since the key last served, not one refused only before.
  it("names only the models it was refused on since its last success", async () => {
    vi.stubEnv("AUTH_SOFT_DEMOTE_DEAD_AFTER_TRIES", "1");
    vi.resetModules();
    const freshAuth = await import("@/sse/services/auth.js");
    const freshDb = await import("@/lib/db/index.js");
    const loadFresh = (id) => freshDb.getProviderConnectionById(id);
    const [key, peer] = await accounts(["a", "b"]);
    const refuseOn = async (model) => {
      await freshAuth.clearAccountError(peer.id, await loadFresh(peer.id), model);
      await freshAuth.markAccountUnavailable(key.id, 403, REFUSED_403, provider, model);
    };
    for (let i = 0; i < 6; i++) {
      if (i > 0) vi.advanceTimersByTime(2 * MIN);
      await refuseOn(OPUS);
    }
    vi.advanceTimersByTime(MIN);
    await refuseOn(KIMI);
    vi.advanceTimersByTime(MIN);
    await freshAuth.clearAccountError(key.id, await loadFresh(key.id), "claude-sonnet-5-5");
    vi.advanceTimersByTime(25 * 60 * MIN);
    await refuseOn("claude-haiku-5-5");
    await refuseOn(OPUS);
    const conn = await loadFresh(key.id);
    expect(conn.isActive).toBe(false);
    expect(conn.autoDisabledReason).toBe(`403 "Key barred from this endpoint" on ${OPUS}, claude-haiku-5-5 for 24h while soft-demoted`);
  });
});

describe("the key's last success while soft-demoted", () => {
  it("is stored at most once a minute", async () => {
    const { key } = await softDemoted();
    // Past the refusal's lock, so a success has nothing else to write.
    vi.advanceTimersByTime(3 * MIN);
    await succeed(key.id, KIMI);
    const first = new Date().toISOString();
    expect((await load(key.id)).authServedAt).toBe(first);
    const before = localDbWrites.count;
    vi.advanceTimersByTime(59 * 1000);
    await succeed(key.id, KIMI);
    expect(localDbWrites.count).toBe(before);
    // A restart now would lose under a minute of it.
    expect(Date.now() - Date.parse((await load(key.id)).authServedAt)).toBeLessThan(MIN);
    vi.advanceTimersByTime(2 * 1000);
    await succeed(key.id, KIMI);
    expect(localDbWrites.count).toBe(before + 1);
    expect(localDbWrites.last.authServedAt).toBe(new Date().toISOString());
  });

  it("is stored within the minute when a soft demotion began after it was", async () => {
    const { key } = await softDemoted();
    const { since } = (await load(key.id))[`authSoft_${OPUS}`];
    await db.updateProviderConnection(key.id, { authServedAt: new Date(Date.parse(since) - 10 * 1000).toISOString() });
    global._authEvents.softKeys.delete(key.id);
    vi.advanceTimersByTime(10 * 1000);
    await succeed(key.id, KIMI);
    expect((await load(key.id)).authServedAt).toBe(new Date().toISOString());
  });

  it("is stored when the success's snapshot predates the soft demotion", async () => {
    const [key, peer] = await accounts(["a", "b"]);
    await refuse(key.id, peer, { times: 5 });
    const snapshot = await load(key.id);
    vi.advanceTimersByTime(2 * MIN);
    await refuse(key.id, peer, { times: 1 });
    expect((await load(key.id))[`authSoft_${OPUS}`]).toMatchObject({ keyRefused: true });
    vi.advanceTimersByTime(MIN);
    await auth.clearAccountError(key.id, snapshot, KIMI);
    expect((await load(key.id)).authServedAt).toBe(new Date().toISOString());
  });

  it("is stored with AUTH_SOFT_DEMOTE=0, so turning it back on doesn't turn off a key that served meanwhile", async () => {
    const { key, peer } = await softDemoted();
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(3 * 60 * MIN);
      await succeed(peer.id, OPUS);
      await failOnce(key.id, OPUS);
    }
    expect((await load(key.id))[`authSoft_${OPUS}`]).toMatchObject({ tries: 6 });
    const events = global._authEvents;
    try {
      vi.stubEnv("AUTH_SOFT_DEMOTE", "0");
      vi.resetModules();
      const offDb = await import("@/lib/db/index.js");
      const offAuth = await import("@/sse/services/auth.js");
      vi.advanceTimersByTime(2 * 60 * MIN);
      // The stored record alone, not this process's memory of soft-demoting it.
      global._authEvents.softKeys.clear();
      await offAuth.clearAccountError(key.id, await offDb.getProviderConnectionById(key.id), KIMI);
      expect((await offDb.getProviderConnectionById(key.id)).authServedAt).toBe(new Date().toISOString());
      // Back on, after a restart.
      vi.stubEnv("AUTH_SOFT_DEMOTE", "1");
      delete global._authEvents;
      global._softDemotions.clear();
      vi.resetModules();
      const onDb = await import("@/lib/db/index.js");
      const onAuth = await import("@/sse/services/auth.js");
      vi.advanceTimersByTime(6 * 60 * MIN);
      await onAuth.clearAccountError(peer.id, await onDb.getProviderConnectionById(peer.id), KIMI);
      await onAuth.markAccountUnavailable(key.id, 403, REFUSED_403, provider, KIMI);
      expect((await onDb.getProviderConnectionById(key.id)).isActive).toBe(true);
    } finally {
      global._authEvents = events;
    }
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
    expect(AUTH_SOFT_DEMOTE).toEqual({ enabled, deadAfterMs: 24 * 60 * MIN, deadAfterTries: 6 });
  });

  it.each([
    [{ AUTH_SOFT_DEMOTE_DEAD_AFTER_MS: "0" }, { deadAfterMs: 0, deadAfterTries: 6 }],
    [{ AUTH_SOFT_DEMOTE_DEAD_AFTER_MS: "3600000", AUTH_SOFT_DEMOTE_DEAD_AFTER_TRIES: "3" }, { deadAfterMs: 60 * MIN, deadAfterTries: 3 }],
    [{ AUTH_SOFT_DEMOTE_DEAD_AFTER_MS: "1d", AUTH_SOFT_DEMOTE_DEAD_AFTER_TRIES: "0" }, { deadAfterMs: 24 * 60 * MIN, deadAfterTries: 6 }],
  ])("reads %j for the turn-off after a long soft demotion", async (env, expected) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    vi.resetModules();
    const { AUTH_SOFT_DEMOTE } = await import("open-sse/config/runtimeConfig.js");
    expect(AUTH_SOFT_DEMOTE).toMatchObject(expected);
  });

  it("set to 0, leaves the key first and counting, as before", async () => {
    vi.stubEnv("AUTH_SOFT_DEMOTE", "0");
    vi.resetModules();
    const freshDb = await import("@/lib/db/index.js");
    const freshAuth = await import("@/sse/services/auth.js");
    const keys = [];
    for (const name of ["a", "b"]) {
      keys.push(await freshDb.createProviderConnection({
        provider, authType: "apikey", name, apiKey: `sk-test-${name}-0123456789`,
        providerSpecificData: { baseUrl: `https://acct-${name}.acme.test/v1`, ownBaseUrl: true },
      }));
    }
    const [key, peer] = keys;
    for (let i = 0; i < 6; i++) {
      if (i > 0) vi.advanceTimersByTime(2 * MIN);
      await freshAuth.clearAccountError(peer.id, await freshDb.getProviderConnectionById(peer.id), OPUS);
      await freshAuth.markAccountUnavailable(key.id, 403, REFUSED_403, provider, OPUS);
    }
    vi.advanceTimersByTime(3 * MIN);
    expect((await freshAuth.getProviderCredentials(provider, null, OPUS)).connectionId).toBe(key.id);
    expect((await freshDb.getProviderConnectionById(key.id)).authFailCount).toBe(6);
  });

  it("set to 0, hides a stored soft demotion everywhere else too, and a success there still removes it", async () => {
    const [key, near] = await accounts(["k", "near"], { shared: true });
    const [far] = await accounts(["far"]);
    await refuse(key.id, far, { times: 6 });
    expect((await load(key.id))[`authSoft_${OPUS}`]).toMatchObject({ keyRefused: true });
    // As if it had served since the router started, and none of its demotion
    // counts were written by this process: only a soft demotion could note a success.
    global._authEvents.servedKeys.add(key.id);
    global._authEvents.demoteKeys.delete(key.id);
    vi.stubEnv("AUTH_SOFT_DEMOTE", "0");
    vi.resetModules();
    const freshDb = await import("@/lib/db/index.js");
    const freshAuth = await import("@/sse/services/auth.js");
    const freshAvailability = await import("@/app/api/models/availability/route.js");
    const freshProviders = await import("@/app/api/providers/route.js");
    const loadFresh = (id) => freshDb.getProviderConnectionById(id);
    vi.advanceTimersByTime(3 * MIN);
    // Not listed or sent to the dashboard.
    const { models } = await (await freshAvailability.GET()).json();
    expect(models.filter((m) => m.connectionId === key.id && m.model === OPUS)).toEqual([]);
    const { connections } = await (await freshProviders.GET()).json();
    expect(connections.find((c) => c.id === key.id)).not.toHaveProperty(`authSoft_${OPUS}`);
    // A refusal elsewhere builds a streak, with the 10-minute window, as before
    // (a 401: it writes no demotion count).
    await freshAuth.clearAccountError(near.id, await loadFresh(near.id), KIMI);
    await freshAuth.markAccountUnavailable(key.id, 401, "Invalid API key", provider, KIMI);
    expect((await loadFresh(key.id)).authFailSameUpstream).toBe(true);
    // A success on another model notes nothing for it.
    const okAt = (await loadFresh(key.id)).authDemoteOkAt;
    vi.advanceTimersByTime(MIN);
    await freshAuth.clearAccountError(key.id, await loadFresh(key.id), "claude-sonnet-5-5");
    expect((await loadFresh(key.id)).authDemoteOkAt).toBe(okAt);
    // A success on it removes it.
    await freshAuth.clearAccountError(key.id, await loadFresh(key.id), OPUS);
    expect((await loadFresh(key.id))[`authSoft_${OPUS}`] ?? null).toBeNull();
  });

  it("set to 0, ignores a demotion 401s built while the key was soft-demoted", async () => {
    const [key, near] = await accounts(["k", "near"], { shared: true });
    const [far] = await accounts(["far"]);
    await refuse(key.id, far, { times: 6 });
    expect((await load(key.id))[`authSoft_${OPUS}`]).toMatchObject({ keyRefused: true });
    for (let i = 0; i < 8; i++) {
      vi.advanceTimersByTime(2 * MIN);
      await succeed(near.id, KIMI);
      await auth.markAccountUnavailable(key.id, 401, "Invalid API key", provider, KIMI);
    }
    expect((await load(key.id))[`authDemote_${KIMI}`]).toMatchObject({ held401: true, demotedAt: expect.any(String) });
    vi.advanceTimersByTime(3 * MIN);
    expect(await pick(KIMI)).not.toBe(key.id);
    vi.stubEnv("AUTH_SOFT_DEMOTE", "0");
    vi.resetModules();
    const freshAuth = await import("@/sse/services/auth.js");
    const freshAvailability = await import("@/app/api/models/availability/route.js");
    const freshProviders = await import("@/app/api/providers/route.js");
    global._softDemotions.clear();
    expect((await freshAuth.getProviderCredentials(provider, null, KIMI)).connectionId).toBe(key.id);
    const { models } = await (await freshAvailability.GET()).json();
    expect(models.filter((m) => m.connectionId === key.id && m.model === KIMI)).toEqual([]);
    const { connections } = await (await freshProviders.GET()).json();
    expect(connections.find((c) => c.id === key.id)).not.toHaveProperty(`authDemote_${KIMI}`);
  });

  const loadShown = async (id) => {
    vi.stubEnv("AUTH_SOFT_DEMOTE", "0");
    vi.resetModules();
    const { connections } = await (await (await import("@/app/api/providers/route.js")).GET()).json();
    return connections.find((c) => c.id === id);
  };

  it("set to 0, ignores a count held 401s began, also once a 403 joined it", async () => {
    const { key, peer } = await softDemoted();
    for (const [status, text] of [...Array(4).fill([401, "Invalid API key"]), [403, REFUSED_403]]) {
      vi.advanceTimersByTime(2 * MIN);
      await succeed(peer.id, KIMI);
      await auth.markAccountUnavailable(key.id, status, text, provider, KIMI);
    }
    const record = (await load(key.id))[`authDemote_${KIMI}`];
    expect(record).toMatchObject({ count: 5, held401: true, lastCountedAt: new Date().toISOString() });
    expect(await loadShown(key.id)).not.toHaveProperty(`authDemote_${KIMI}`);
  });

  it("set to 0, still honours a demotion 403s made before the key was held, after a held 401 probe", async () => {
    // Kimi demoted by 403s its near peer served; then soft-demoted on opus, which only the far peer serves.
    const [key, near] = await accounts(["k", "near"], { shared: true });
    const [far] = await accounts(["far"]);
    await refuse(key.id, near, { times: 6, model: KIMI });
    const demoted = (await load(key.id))[`authDemote_${KIMI}`];
    expect(demoted).toMatchObject({ count: 6, demotedAt: expect.any(String) });
    vi.advanceTimersByTime(MIN);
    await succeed(key.id, "claude-sonnet-5-5");
    await refuse(key.id, far, { times: 6 });
    expect((await load(key.id))[`authSoft_${OPUS}`]).toMatchObject({ keyRefused: true });
    vi.advanceTimersByTime(30 * MIN);
    await succeed(near.id, KIMI);
    await auth.markAccountUnavailable(key.id, 401, "Invalid API key", provider, KIMI);
    const record = (await load(key.id))[`authDemote_${KIMI}`];
    expect(record).toMatchObject({ count: 7, demotedAt: demoted.demotedAt, lastCountedAt: demoted.lastCountedAt });
    expect(record.held401).toBeUndefined();
    expect((await loadShown(key.id))[`authDemote_${KIMI}`]).toMatchObject({ count: 7, demotedAt: demoted.demotedAt });
  });

  it("keeps the 401s in a row through a refusal of just the model", async () => {
    const { key, peer } = await softDemoted();
    const lacks = `[403]: {"error":{"message":"Your organization does not have access to model ${KIMI}"}}`;
    for (const [status, text] of [...Array(4).fill([401, "Invalid API key"]), [403, lacks], [401, "Invalid API key"]]) {
      vi.advanceTimersByTime(2 * MIN);
      await succeed(peer.id, KIMI);
      await auth.markAccountUnavailable(key.id, status, text, provider, KIMI);
    }
    expect((await load(key.id)).authHeld401s).toBe(5);
  });

  it("clears the 401s in a row with a new key or a toggle", async () => {
    const { key, peer } = await softDemoted();
    const held401 = async () => {
      vi.advanceTimersByTime(2 * MIN);
      await succeed(peer.id, KIMI);
      await auth.markAccountUnavailable(key.id, 401, "Invalid API key", provider, KIMI);
      expect((await load(key.id)).authHeld401s).toBe(1);
    };
    await held401();
    await db.updateProviderConnection(key.id, { isActive: false });
    await db.updateProviderConnection(key.id, { isActive: true });
    expect((await load(key.id)).authHeld401s ?? null).toBeNull();
    await refuse(key.id, peer, { times: 6 });
    await held401();
    await db.updateProviderConnection(key.id, { apiKey: "sk-test-a-new-0123456789" });
    expect((await load(key.id)).authHeld401s ?? null).toBeNull();
  });

  it("set to 0, records no dead key for a key replaced while soft-demoted", async () => {
    const { key } = await softDemoted();
    vi.stubEnv("AUTH_SOFT_DEMOTE", "0");
    vi.resetModules();
    const freshDb = await import("@/lib/db/index.js");
    await freshDb.updateProviderConnection(key.id, { apiKey: "sk-test-a-replaced-0123456789" });
    expect((await freshDb.getProviderConnectionById(key.id)).pastKeys).toBeUndefined();
  });

  it("set to 0, ignores a soft demotion stored while it was on", async () => {
    const { key, peer } = await softDemoted();
    expect((await load(key.id))[`authSoft_${OPUS}`]).toBeTruthy();
    vi.stubEnv("AUTH_SOFT_DEMOTE", "0");
    vi.resetModules();
    const freshDb = await import("@/lib/db/index.js");
    const freshAuth = await import("@/sse/services/auth.js");
    global._softDemotions.clear();
    vi.advanceTimersByTime(3 * MIN);
    expect((await freshAuth.getProviderCredentials(provider, null, OPUS)).connectionId).toBe(key.id);
    await freshAuth.clearAccountError(peer.id, await freshDb.getProviderConnectionById(peer.id), OPUS);
    await freshAuth.markAccountUnavailable(key.id, 403, REFUSED_403, provider, OPUS);
    expect(await freshDb.getProviderConnectionById(key.id)).toMatchObject({ authFailCount: 1, [`authDemote_${OPUS}`]: { count: 1 } });
  });
});
