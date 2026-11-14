// Routing scenarios for one key K beside healthy peers, fill-first, through the
// public auth calls: a sweep of incidents, seeded random traffic (with models K
// lacks, and peers on mixed upstreams), and K refused on one model while it
// lacks two others. Writes the minute K went off per case (null: never) to
// COMPARE_OUT. With COMPARE_MASTER=<file> (the same run on master's auth code),
// it checks that no case goes off sooner than there, or where it stays on.
//   cd tests && ./node_modules/.bin/vitest run --config ./vitest.stress.config.js unit/auto-disable-compare-stress.test.js
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

// K first, then its peers. "own": K on its own account, the peer on another;
// "shared": both on one; "mixed": K and a near peer on one, which lacks
// `nearLacks`, and a far peer on another.
const LAYOUTS = {
  own: [["k", "own"], ["peer", "shared"]],
  shared: [["k", "shared"], ["peer", "shared"]],
  mixed: [["k", "near"], ["near", "near"], ["far", "far"]],
};
async function setup(layout) {
  provider = `auth-compare-${++seq}`;
  vi.setSystemTime(new Date("2026-10-23T00:00:00.000Z"));
  const keys = {};
  for (const [name, account] of LAYOUTS[layout]) {
    keys[name] = await db.createProviderConnection({
      provider, authType: "apikey", name, apiKey: `sk-test-${name}-0123456789`,
      providerSpecificData: { baseUrl: `https://acct-${account}.acme.test/v1` },
    });
  }
  return keys;
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
async function offMinute(layout, totalMin, traffic, refused, nearLacks = null) {
  const keys = await setup(layout);
  const refuses = (minute, model) => (id) => (id === keys.k.id && refused(minute, model))
    || (id === keys.near?.id && model === nearLacks);
  for (let minute = 0; minute < totalMin; minute++) {
    if (minute > 0) vi.advanceTimersByTime(MIN);
    for (const model of traffic(minute)) await serve(model, refuses(minute, model));
    if ((await db.getProviderConnectionById(keys.k.id)).isActive === false) return minute;
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
      cases[`sweep ${l1},${g},${l2}`] = (layout) => offMinute(layout, l1 + g + l2 + 120,
        (m) => (m < l1 + g ? ["opus"] : ["opus", "sonnet"]), (m) => within(m, [[0, l1], [l1 + g, l1 + g + l2]]), "opus");
    }
  }
}
// Seeded sessions on 1-3 models with idle spells, 1-3 incidents of 3-123
// minutes, and in some seeds one or two models K lacks; 6 hours.
const SEEDS = [...Array.from({ length: 75 }, (_, i) => i + 1),
  173, 193, 326, 432, 493, 540, 564, 639, 640, 670, 759, 833, 948, 993, 1182, 1194, 1283, 1418, 1430, 1470, 1471, 1631, 1643, 1722];
for (const seed of SEEDS) {
  cases[`fuzz ${seed}`] = (layout) => {
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
    const odds = r();
    const lacks = [...MODELS].sort(() => r() - 0.5).slice(0, odds < 0.3 ? 1 : odds < 0.45 ? 2 : 0);
    const nearLacks = MODELS[Math.floor(r() * MODELS.length)];
    return offMinute(layout, totalMin, (m) => schedule[m], (m, model) => lacks.includes(model) || within(m, incidents), nearLacks);
  };
}
// Opus every minute, K refused on it until `end`; from end + `off`, sonnet and
// haiku every `every` minutes, which K is refused on for `forMin` minutes (or
// always: it lacks them); 12 hours.
for (const [end, off, every, forMin] of [
  [85, 10, 2, 75], [90, 0, 2, Infinity], [180, 30, 2, Infinity], [360, 0, 2, Infinity], [380, 30, 2, Infinity],
  [85, 0, 5, Infinity], [90, 10, 5, Infinity], [100, 0, 5, Infinity],
]) {
  cases[`lacks two ${end},${off},${every},${forMin}`] = (layout) => offMinute(layout, 720,
    (m) => (m >= end + off && (m - end - off) % every === 0 ? ["opus", "sonnet", "haiku"] : ["opus"]),
    (m, model) => (model === "opus" ? m < end : m >= end + off && m < end + off + forMin), "opus");
}
// Opus, which only the far peer serves, every minute for 13 minutes, K refused
// on it; then sonnet and haiku in turn, a minute apart, which the near peer
// serves and K is refused on until `end`; 4 hours.
for (const end of [40, 70]) {
  cases[`near after far ${end}`] = (layout) => offMinute(layout, 240,
    (m) => (m < 13 ? ["opus"] : [m % 2 ? "sonnet" : "haiku"]), (m, model) => (model === "opus" ? m < 13 : m < end), "opus");
}

// Opus, which only the far peer serves, every minute for 13 minutes, K refused
// on it; then idle; from `start`, a burst of sonnet and haiku every `gap`
// minutes, which the near peer serves and K is refused on (until `stop`).
for (const [start, gap, totalMin, stop = Infinity] of [
  [80, 20, 200], [80, 15, 200], [75, 12, 200], [80, 30, 220], [80, 20, 145], [1440, 20, 1560], [80, 20, 260, 142],
]) {
  cases[`idle then near ${start},${gap},${totalMin},${stop}`] = (layout) => offMinute(layout, totalMin,
    (m) => (m < 13 ? ["opus"] : m >= start && m < stop && (m - start) % gap === 0 ? ["sonnet", "haiku"] : []),
    (m, model) => (model === "opus" ? m < 13 : true), "opus");
}
// The same, with bursts alternating between two pairs of models.
cases["idle then near, rotating"] = (layout) => offMinute(layout, 260,
  (m) => (m < 13 ? ["opus"] : m >= 80 && (m - 80) % 15 === 0 ? (((m - 80) / 15) % 2 ? ["sonnet", "haiku"] : ["m4", "m5"]) : []),
  (m, model) => (model === "opus" ? m < 13 : true), "opus");

it("turns no key off sooner than master, or where master keeps it on", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const out = {};
  for (const [name, run] of Object.entries(cases)) {
    for (const layout of Object.keys(LAYOUTS)) out[`${layout}: ${name}`] = await run(layout);
  }
  if (process.env.COMPARE_OUT) fs.writeFileSync(process.env.COMPARE_OUT, JSON.stringify(out, null, 2));
  if (!process.env.COMPARE_MASTER) return;
  const master = JSON.parse(fs.readFileSync(process.env.COMPARE_MASTER, "utf8"));
  expect(Object.keys(out).sort()).toEqual(Object.keys(master).sort());
  const sooner = Object.entries(out).filter(([name, minute]) => minute !== null && (master[name] === null || minute < master[name]));
  expect(sooner).toEqual([]);
}, 3600000);
