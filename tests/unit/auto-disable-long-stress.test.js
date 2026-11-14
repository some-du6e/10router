// A dead key K beside healthy peers for 48 hours, fill-first, through the
// public auth calls: opus every minute, alone or with sonnet and haiku every
// 9 minutes from minute 12; or K serving sonnet every 9 minutes until it dies
// at minute 180. Writes when K was soft-demoted, last served and went off, and
// its refusals in the first 24 and 48 hours, to LONG_OUT. On code with soft
// demotion, K refused on two models or more must go off at its first refusal
// a day after the later of its soft demotion and its last success: between
// that and that plus the longest try interval. Refused on opus only, it stays
// on, as on master.
//   cd tests && ./node_modules/.bin/vitest run --config ./vitest.stress.config.js unit/auto-disable-long-stress.test.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ NextResponse: { json: (b, i = {}) => new Response(JSON.stringify(b), { status: i.status || 200 }) } }));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

const originalDataDir = process.env.DATA_DIR;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-auth-long-"));
process.env.DATA_DIR = tempDir;

const MIN = 60 * 1000;
const DAY_MIN = 24 * 60;
const REFUSED_403 = '[403]: {"code":"000000","message":"Key barred from this endpoint"}';
let db, auth, runtime, errors, provider, seq = 0;

beforeAll(async () => {
  db = await import("@/lib/db/index.js");
  auth = await import("@/sse/services/auth.js");
  runtime = await import("open-sse/config/runtimeConfig.js");
  errors = await import("open-sse/config/errorConfig.js");
});
afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

// K on its own account beside a peer; or "mixed": K and a near peer, which
// lacks opus, on one, and a far peer on another.
const LAYOUTS = {
  own: [["k", "own"], ["peer", "shared"]],
  mixed: [["k", "near"], ["near", "near"], ["far", "far"]],
};
async function setup(layout) {
  provider = `auth-long-${++seq}`;
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

// One request: keys in routing order until one serves. K's refusals, and the
// key that served.
async function serve(model, refused) {
  let kRefusals = 0;
  const tried = new Set();
  for (;;) {
    const creds = await auth.getProviderCredentials(provider, tried, model);
    if (!creds?.connectionId) return { kRefusals, served: null };
    const outcome = refused(creds.connectionId);
    if (!outcome) {
      await auth.clearAccountError(creds.connectionId, creds, model);
      return { kRefusals, served: creds.connectionId };
    }
    if (outcome === "k") kRefusals++;
    await auth.markAccountUnavailable(creds.connectionId, 403, REFUSED_403, provider, model);
    tried.add(creds.connectionId);
  }
}

// The models requested at minute m, and whether K is refused on one.
const TRAFFIC = {
  "opus only": { models: () => ["opus"], kRefused: () => true },
  "three models": { models: (m) => (m >= 12 && (m - 12) % 9 === 0 ? ["opus", "sonnet", "haiku"] : ["opus"]), kRefused: () => true },
  "serves sonnet until minute 180": { models: (m) => (m % 9 === 0 ? ["opus", "sonnet"] : ["opus"]), kRefused: (model, m) => model === "opus" || m >= 180 },
};

it("turns a soft-demoted dead key off a day after its soft demotion or last success", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const out = {};
  for (const layout of Object.keys(LAYOUTS)) {
    for (const [name, { models, kRefused }] of Object.entries(TRAFFIC)) {
      const keys = await setup(layout);
      let off = null, softAt = null, lastServed = null;
      const refusals = { day: 0, twoDays: 0 };
      for (let m = 0; m < 2 * DAY_MIN; m++) {
        if (m > 0) vi.advanceTimersByTime(MIN);
        for (const model of models(m)) {
          const { kRefusals, served } = await serve(model, (id) => (id === keys.k.id ? (kRefused(model, m) ? "k" : null)
            : id === keys.near?.id && model === "opus" ? "near" : null));
          if (served === keys.k.id) lastServed = m;
          refusals.twoDays += kRefusals;
          if (m < DAY_MIN) refusals.day += kRefusals;
        }
        const k = await db.getProviderConnectionById(keys.k.id);
        if (softAt === null && Object.entries(k).some(([f, r]) => f.startsWith("authSoft_") && r?.keyRefused)) softAt = m;
        if (off === null && k.isActive === false) off = m;
      }
      out[`${layout}: ${name}`] = { softAt, lastServed, off, ...refusals };
    }
  }
  console.log(JSON.stringify(out, null, 2));
  if (process.env.LONG_OUT) fs.writeFileSync(process.env.LONG_OUT, JSON.stringify(out, null, 2));
  const soft = runtime.AUTH_SOFT_DEMOTE;
  if (!soft?.deadAfterMs) return;
  const longestTryMin = Math.max(...errors.AUTH_DEMOTE_CONFIG.probeMs) / MIN;
  for (const [name, { softAt, lastServed, off }] of Object.entries(out)) {
    // Refused on one model only, it stays on, as on master (minModels).
    if (name.endsWith("opus only")) {
      expect([name, softAt !== null && off === null]).toEqual([name, true]);
      continue;
    }
    const from = Math.max(softAt, lastServed ?? -Infinity);
    expect([name, softAt !== null && off - from >= soft.deadAfterMs / MIN && off - from <= soft.deadAfterMs / MIN + longestTryMin]).toEqual([name, true]);
  }
}, 3600000);
