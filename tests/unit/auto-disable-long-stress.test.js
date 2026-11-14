// A dead key K beside healthy peers for 48 hours, fill-first, through the
// public auth calls: opus every minute, alone or with sonnet and haiku every
// 9 minutes from minute 12. Writes when K went off and its refusals in the first 24 and 48
// hours to LONG_OUT. On code with soft demotion, K, soft-demoted, must go off at
// its first refused try after 24 hours: between 24 hours and 24 hours plus the
// longest try interval.
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

async function serve(model, refused) {
  let kRefusals = 0;
  const tried = new Set();
  for (;;) {
    const creds = await auth.getProviderCredentials(provider, tried, model);
    if (!creds?.connectionId) return kRefusals;
    const outcome = refused(creds.connectionId);
    if (!outcome) {
      await auth.clearAccountError(creds.connectionId, creds, model);
      return kRefusals;
    }
    if (outcome === "k") kRefusals++;
    await auth.markAccountUnavailable(creds.connectionId, 403, REFUSED_403, provider, model);
    tried.add(creds.connectionId);
  }
}

const TRAFFIC = {
  "opus only": () => ["opus"],
  "three models": (m) => (m >= 12 && (m - 12) % 9 === 0 ? ["opus", "sonnet", "haiku"] : ["opus"]),
};

it("turns a soft-demoted dead key off after a day", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const out = {};
  for (const layout of Object.keys(LAYOUTS)) {
    for (const [name, traffic] of Object.entries(TRAFFIC)) {
      const keys = await setup(layout);
      let off = null;
      const refusals = { day: 0, twoDays: 0 };
      for (let m = 0; m < 2 * DAY_MIN; m++) {
        if (m > 0) vi.advanceTimersByTime(MIN);
        for (const model of traffic(m)) {
          const n = await serve(model, (id) => (id === keys.k.id ? "k" : id === keys.near?.id && model === "opus" ? "near" : null));
          refusals.twoDays += n;
          if (m < DAY_MIN) refusals.day += n;
        }
        if (off === null && (await db.getProviderConnectionById(keys.k.id)).isActive === false) off = m;
      }
      out[`${layout}: ${name}`] = { off, ...refusals };
    }
  }
  console.log(JSON.stringify(out, null, 2));
  if (process.env.LONG_OUT) fs.writeFileSync(process.env.LONG_OUT, JSON.stringify(out, null, 2));
  const soft = runtime.AUTH_SOFT_DEMOTE;
  if (!soft?.deadAfterMs) return;
  const longestTryMin = Math.max(...errors.AUTH_DEMOTE_CONFIG.probeMs) / MIN;
  for (const [name, { off }] of Object.entries(out)) {
    expect([name, off >= soft.deadAfterMs / MIN && off <= soft.deadAfterMs / MIN + longestTryMin]).toEqual([name, true]);
  }
}, 3600000);
