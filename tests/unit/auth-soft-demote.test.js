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

  it("ends when the key is switched off and on", async () => {
    const { key, peer } = await softDemoted();
    vi.advanceTimersByTime(3 * MIN);
    expect(await pick(OPUS)).toBe(peer.id);
    await db.updateProviderConnection(key.id, { isActive: false });
    await db.updateProviderConnection(key.id, { isActive: true });
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

  it("never turns it off while it is soft-demoted, however often it is refused elsewhere", async () => {
    // The key and its near peer on one upstream; only the far peer serves opus.
    const [key, near] = await accounts(["k", "near"], { shared: true });
    const [far] = await accounts(["far"]);
    await refuse(key.id, far, { times: 6 });
    expect(auth.__test__.softDemoted(await load(key.id), OPUS)).toBe(true);
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
    const { key } = await softDemoted();
    await db.updateProviderConnection(key.id, { apiKey: "sk-test-a-replaced-0123456789" });
    expect((await load(key.id)).pastKeys).toEqual([{ since: expect.any(String), until: new Date().toISOString() }]);
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
    const { key } = await softDemoted();
    await db.updateProviderConnection(key.id, { isActive: false });
    await db.updateProviderConnection(key.id, { apiKey: "sk-test-a-replaced-0123456789" });
    expect((await load(key.id)).pastKeys).toEqual([{ since: expect.any(String), until: new Date().toISOString() }]);
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
    expect(AUTH_SOFT_DEMOTE).toEqual({ enabled });
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
