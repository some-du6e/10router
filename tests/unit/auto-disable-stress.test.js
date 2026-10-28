// Replays the routing scenarios behind auth.js's dead-key rules (turning keys off,
// demoting them on one model) and prints what happened. It uses only the
// public auth calls, so the same file runs on any version of auth.js: run it
// here and on master to compare.
//   cd tests && npx vitest run --config ./vitest.stress.config.js unit/auto-disable-stress.test.js
// Set STRESS_OUT=<file> to also write the results as JSON.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ NextResponse: { json: (b, i = {}) => new Response(JSON.stringify(b), { status: i.status || 200 }) } }));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

const originalDataDir = process.env.DATA_DIR;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-auth-stress-"));
process.env.DATA_DIR = tempDir;

const MIN = 60 * 1000;
const DEAD_403 = '[403]: {"code":"003001","message":"Not authorized for this endpoint"}';
const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
const HAIKU = "claude-haiku-5-5";
const KIMI = "kimi-k3";
const MODELS = [OPUS, SONNET, HAIKU];
let db, auth, provider, seq = 0;

beforeAll(async () => {
  db = await import("@/lib/db/index.js");
  auth = await import("@/sse/services/auth.js");
});
afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const rng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// Keys of one provider, the first on its own account when `cross`, the rest on
// a shared one.
async function setup(names, cross = false) {
  provider = `auth-stress-${++seq}`;
  global._authEvents?.success?.clear();
  global._authEvents?.refused?.clear();
  vi.setSystemTime(new Date("2026-10-23T00:00:00.000Z"));
  const keys = [];
  for (const [i, name] of names.entries()) {
    const own = cross && i === 0;
    keys.push(await db.createProviderConnection({
      provider, authType: "apikey", name, apiKey: `sk-test-${name}-0123456789`,
      providerSpecificData: {
        baseUrl: `https://${own ? "acct-own" : "acct-shared"}.snowflakecomputing.test/api/v2/cortex/v1`,
        ...(own ? { ownBaseUrl: true } : {}),
      },
    }));
  }
  return keys;
}

// One request as the router serves it: fill-first, falling back past refusals.
// Returns the key that served it, or null.
async function serve(model, refuses) {
  const tried = new Set();
  for (;;) {
    const creds = await auth.getProviderCredentials(provider, tried, model);
    if (!creds?.connectionId) return null;
    if (!refuses(creds.connectionId)) {
      await auth.clearAccountError(creds.connectionId, creds, model);
      return creds.connectionId;
    }
    await auth.markAccountUnavailable(creds.connectionId, 403, DEAD_403, provider, model);
    tried.add(creds.connectionId);
  }
}

// requests(minute) gives [[model, refuses(id)], ...] for that minute. Returns
// each key's refusals per model, the minute each key went off, and who served.
async function run(keys, totalMin, requests) {
  const offAt = {};
  const refusals = {};
  const served = [];
  for (let minute = 0; minute < totalMin; minute++) {
    if (minute > 0) vi.advanceTimersByTime(MIN);
    for (const [model, refuses] of requests(minute)) {
      const counting = (id) => {
        const refused = refuses(id);
        if (refused) ((refusals[id] ??= {})[model] ??= []).push(minute);
        return refused;
      };
      served.push([minute, model, await serve(model, counting)]);
    }
    for (const k of keys) {
      if (offAt[k.id] === undefined && (await db.getProviderConnectionById(k.id)).isActive === false) offAt[k.id] = minute;
    }
  }
  return { offAt, refusals, served };
}

const session = (workMin, idleMin) => (m) => m % (workMin + idleMin) < workMin;
const tenOnThirteenOff = session(10, 13);

it("replays the dead-key scenarios", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const out = {};

  // The live case: only opus, 10 minutes on and 13 off, 12 hours, the dead key
  // on its own account or the peer's.
  out.prodPattern = {};
  for (const cross of [true, false]) {
    const [dead] = await setup(["dead", "peer"], cross);
    const { refusals } = await run([dead], 12 * 60, (m) => (tenOnThirteenOff(m) ? [[OPUS, (id) => id === dead.id]] : []));
    out.prodPattern[cross ? "other account" : "same account"] = refusals[dead.id]?.[OPUS]?.length ?? 0;
  }

  // An incident on opus that ends: minutes from its end until the key serves opus again.
  out.incidentRecovery = {};
  for (const [pattern, active] of [["every minute", () => true], ["10 on / 13 off", tenOnThirteenOff]]) {
    for (const incidentMin of [30, 60, 120, 180, 360, 720, 4320]) {
      const [k] = await setup(["k", "peer"]);
      const { served } = await run([k], incidentMin + 12 * 60, (m) => (active(m) ? [[OPUS, (id) => id === k.id && m < incidentMin]] : []));
      const back = served.find(([minute, , id]) => minute >= incidentMin && id === k.id)?.[0];
      out.incidentRecovery[`${pattern}, ${incidentMin} min`] = back === undefined ? null : back - incidentMin;
    }
  }

  // An incident on opus (30-120 min) ends; a 3-minute sonnet blip comes before
  // the next opus probe. Runs that turned the key off.
  let blipOff = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const r = rng(seed);
    const [k] = await setup(["k", "peer"]);
    const incidentMin = 30 + Math.floor(r() * 91);
    const blipAt = incidentMin + 5 + Math.floor(r() * 56);
    const { offAt } = await run([k], incidentMin + 4 * 60, (m) => [
      [OPUS, (id) => id === k.id && m < incidentMin],
      ...(m >= blipAt && m < blipAt + 3 ? [[SONNET, (id) => id === k.id]] : []),
    ]);
    if (offAt[k.id] !== undefined) blipOff++;
  }
  out.incidentThenBlip = `${blipOff}/30 off`;

  // A key refused at random on a share of requests, a healthy peer, 12 hours.
  out.flaky = {};
  for (const share of [0.2, 0.4]) {
    let off = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const r = rng(seed * 7);
      const [k] = await setup(["k", "peer"]);
      const { offAt } = await run([k], 12 * 60, () => {
        const model = MODELS[Math.floor(r() * 3)];
        const refused = r() < share;
        return [[model, (id) => id === k.id && refused]];
      });
      if (offAt[k.id] !== undefined) off++;
    }
    out.flaky[`${share * 100}%`] = `${off}/30 off`;
  }

  // 4 keys, every one refused at random on 40% of tries.
  let peersOff = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const r = rng(seed * 13);
    const keys = await setup(["a", "b", "c", "d"]);
    const { offAt } = await run(keys, 12 * 60, () => [[MODELS[Math.floor(r() * 3)], () => r() < 0.4]]);
    peersOff += Object.keys(offAt).length;
  }
  out.flakyAllPeers = `${peersOff} of 40 keys off over 10 runs`;

  // A key dead on every model, used one model at a time: minutes until off.
  const s = tenOnThirteenOff;
  const patterns = {
    "sonnet, then opus": (m) => (s(m) ? (m < 180 ? SONNET : OPUS) : null),
    "sessions alternating sonnet and opus": (m) => (s(m) ? (Math.floor(m / 23) % 2 ? OPUS : SONNET) : null),
    "opus, plus sonnet every 2 h": (m) => (m % 120 === 60 ? SONNET : s(m) ? OPUS : null),
    "opus, then haiku": (m) => (s(m) ? (m < 180 ? OPUS : HAIKU) : null),
    "one model at a time, 2 h each": (m) => (s(m) ? MODELS[Math.floor(m / 120) % 3] : null),
    "bursty, 2 models": (m) => (m % 30 < 4 ? (m % 2 ? OPUS : SONNET) : null),
  };
  out.deadOnEveryModel = {};
  for (const cross of [false, true]) {
    for (const [name, modelAt] of Object.entries(patterns)) {
      const [dead] = await setup(["dead", "peer"], cross);
      const { offAt } = await run([dead], 12 * 60, (m) => (modelAt(m) ? [[modelAt(m), (id) => id === dead.id]] : []));
      out.deadOnEveryModel[`${cross ? "other account" : "same account"}: ${name}`] = offAt[dead.id] ?? null;
    }
  }

  // A key refused on opus and kimi that serves sonnet, every model each minute, 6 hours.
  const [partial] = await setup(["partial", "peer"]);
  const partialRun = await run([partial], 6 * 60, () => [OPUS, KIMI, SONNET].map((model) => [model, (id) => id === partial.id && model !== SONNET]));
  out.lacksTwoModels = {
    refusals: Object.fromEntries(Object.entries(partialRun.refusals[partial.id] ?? {}).map(([m, at]) => [m, at.length])),
    turnedOff: partialRun.offAt[partial.id] !== undefined,
  };

  console.log(JSON.stringify(out, null, 2));
  if (process.env.STRESS_OUT) fs.writeFileSync(process.env.STRESS_OUT, JSON.stringify(out, null, 2));
  expect(out.lacksTwoModels.turnedOff).toBe(false);
}, 3600000);
