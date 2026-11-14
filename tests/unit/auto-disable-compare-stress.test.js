// Routing scenarios for one key K beside a healthy peer, fill-first, through
// the public auth calls: a sweep of incidents, seeded random traffic, and K
// refused on one model while it lacks two others. The minute master's auth
// code turned K off is pinned per case (auto-disable-compare.master.json, null
// for never). This code must turn K off no sooner, and never where master
// keeps it on.
//   cd tests && ./node_modules/.bin/vitest run --config ./vitest.stress.config.js unit/auto-disable-compare-stress.test.js
// COMPARE_BASELINE=master asserts the minutes equal the pins instead (run it on
// master's auth code); COMPARE_OUT=<file> writes them.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ NextResponse: { json: (b, i = {}) => new Response(JSON.stringify(b), { status: i.status || 200 }) } }));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

const originalDataDir = process.env.DATA_DIR;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-auth-compare-"));
process.env.DATA_DIR = tempDir;

const MIN = 60 * 1000;
const REFUSED_403 = '[403]: {"code":"000000","message":"Key barred from this endpoint"}';
const MODELS = ["opus", "sonnet", "haiku"];
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

// K on its own account, or on the peer's.
async function setup(own) {
  provider = `auth-compare-${++seq}`;
  vi.setSystemTime(new Date("2026-10-23T00:00:00.000Z"));
  const keys = [];
  for (const name of ["k", "peer"]) {
    keys.push(await db.createProviderConnection({
      provider, authType: "apikey", name, apiKey: `sk-test-${name}-0123456789`,
      providerSpecificData: { baseUrl: `https://${own && name === "k" ? "acct-own" : "acct-shared"}.acme.test/v1` },
    }));
  }
  return keys[0];
}

async function serve(model, refused) {
  const tried = new Set();
  for (;;) {
    const creds = await auth.getProviderCredentials(provider, tried, model);
    if (!creds?.connectionId) return;
    if (!refused(creds.connectionId)) {
      await auth.clearAccountError(creds.connectionId, creds, model);
      return;
    }
    await auth.markAccountUnavailable(creds.connectionId, 403, REFUSED_403, provider, model);
    tried.add(creds.connectionId);
  }
}

// traffic(minute) gives the models asked for; refused(minute, model) whether K
// is. The minute K went off, or null.
async function offMinute(own, totalMin, traffic, refused) {
  const k = await setup(own);
  for (let minute = 0; minute < totalMin; minute++) {
    if (minute > 0) vi.advanceTimersByTime(MIN);
    for (const model of traffic(minute)) await serve(model, (id) => id === k.id && refused(minute, model));
    if ((await db.getProviderConnectionById(k.id)).isActive === false) return minute;
  }
  return null;
}

const within = (minute, ranges) => ranges.some(([a, b]) => minute >= a && minute < b);

const cases = {};
// Opus every minute; K refused for l1 minutes, works for g, then is refused
// for l2 while sonnet is in use too.
for (const l1 of [45, 50, 55, 59]) {
  for (const g of [2, 5, 10, 20]) {
    for (const l2 of [3, 8]) {
      cases[`sweep ${l1},${g},${l2}`] = (own) => offMinute(own, l1 + g + l2 + 120,
        (m) => (m < l1 + g ? ["opus"] : ["opus", "sonnet"]), (m) => within(m, [[0, l1], [l1 + g, l1 + g + l2]]));
    }
  }
}
// Seeded sessions on 1-3 models with idle spells, 1-3 incidents of 3-123
// minutes, and in 3 seeds of 10 a model K lacks; 6 hours.
const SEEDS = [...Array.from({ length: 75 }, (_, i) => i + 1),
  12, 173, 193, 326, 432, 493, 540, 564, 639, 640, 670, 759, 833, 948, 993, 1182, 1194, 1283, 1418, 1430, 1470, 1471, 1631, 1643, 1722];
for (const seed of SEEDS) {
  cases[`fuzz ${seed}`] = (own) => {
    const r = rng(seed);
    const totalMin = 360;
    const schedule = [];
    for (let m = 0; m < totalMin;) {
      const len = 3 + Math.floor(r() * 90);
      const idle = r() < 0.4;
      const nModels = 1 + Math.floor(r() * (r() < 0.7 ? 1 : 2.99));
      const models = [...MODELS].sort(() => r() - 0.5).slice(0, nModels);
      const every = [1, 1, 2, 3, 5][Math.floor(r() * 5)];
      for (let i = 0; i < len && m < totalMin; i++, m++) schedule.push(!idle && m % every === 0 ? models : []);
    }
    const incidents = Array.from({ length: 1 + Math.floor(r() * 3) }, () => {
      const a = Math.floor(r() * totalMin * 0.8);
      return [a, a + 3 + Math.floor(r() * 120)];
    });
    const lacks = r() < 0.3 ? MODELS[Math.floor(r() * MODELS.length)] : null;
    return offMinute(own, totalMin, (m) => schedule[m], (m, model) => model === lacks || within(m, incidents));
  };
}
// Opus every minute, K refused on it until `end`; from end + `off`, sonnet and
// haiku every `every` minutes, which K is refused on for `forMin` minutes (or
// always: it lacks them); 12 hours.
for (const [end, off, every, forMin] of [
  [85, 10, 2, 75], [90, 0, 2, Infinity], [180, 30, 2, Infinity], [360, 0, 2, Infinity], [380, 30, 2, Infinity],
  [85, 0, 5, Infinity], [90, 10, 5, Infinity], [100, 0, 5, Infinity],
]) {
  cases[`lacks two ${end},${off},${every},${forMin}`] = (own) => offMinute(own, 720,
    (m) => (m >= end + off && (m - end - off) % every === 0 ? ["opus", "sonnet", "haiku"] : ["opus"]),
    (m, model) => (model === "opus" ? m < end : m >= end + off && m < end + off + forMin));
}

it("turns no key off sooner than master, or where master keeps it on", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const out = {};
  for (const [name, run] of Object.entries(cases)) {
    for (const own of [true, false]) out[`${own ? "own account" : "shared account"}: ${name}`] = await run(own);
  }
  if (process.env.COMPARE_OUT) fs.writeFileSync(process.env.COMPARE_OUT, JSON.stringify(out, null, 2));
  const master = JSON.parse(fs.readFileSync(new URL("./auto-disable-compare.master.json", import.meta.url), "utf8"));
  if (process.env.COMPARE_BASELINE === "master") {
    expect(out).toEqual(master);
    return;
  }
  expect(Object.keys(out).sort()).toEqual(Object.keys(master).sort());
  const sooner = Object.entries(out).filter(([name, minute]) => minute !== null && (master[name] === null || minute < master[name]));
  expect(sooner).toEqual([]);
}, 3600000);
