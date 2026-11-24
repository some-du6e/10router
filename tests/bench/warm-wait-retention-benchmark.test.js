// How much memory each request keeps while it waits for a warm prompt-cache
// key, before its reply has started.
//
// Drives the real path in-process (POST /v1/messages route → handleChat →
// combo → account loop → chatCore → DefaultExecutor → fetch) against a local
// OpenAI-compatible upstream with two keys: a warm one, which served each
// conversation first, and a cold one. Each request goes to its warm key, which
// answers 429 once every request has reached it. The 429 locks that key for a
// few seconds, so every request then waits for it ("[CACHE] waiting Nms for a
// key holding this conversation's prompt cache") instead of rebuilding its
// prompt cache on the cold key. While all WAITING requests wait, the bench
// forces a full GC and reports the heap and the memory outside it (Buffers)
// they hold, per request and against the size of one body. When the lock
// ends they resume on the warm key, which answers; the bench checks that each
// one was sent the very bytes its first attempt was. In-process, so Next's
// own copy of each body (src/lib/proxyBodyCopy.js) isn't here: see
// .github/e2e/warm-wait for the production server.
//
//   cd tests && ./node_modules/.bin/vitest run --config vitest.benchmark.config.js bench/warm-wait-retention-benchmark.test.js
//
// BENCH_WAITING (default 40) sets the concurrent waiting requests,
// BENCH_BODY_MESSAGES (default 220) the history length. BENCH_SNAPSHOT=<path>
// writes a heap snapshot while they wait (use a small BENCH_WAITING).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import v8 from "node:v8";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { heap, settle, socketBody } from "../helpers/heldStreams.js";
import { claudeCodeHeaders, conversation, countWaitLines, seedWarmCold, startWarmUpstream } from "../helpers/warmWait.js";

const WAITING = Number(process.env.BENCH_WAITING || 40);
const MESSAGES = Number(process.env.BENCH_BODY_MESSAGES || 220);
const MB = 1024 * 1024;
const WARM_KEY = "sk-bench-warm-not-a-real-key-0000";
const COLD_KEY = "sk-bench-cold-not-a-real-key-0000";

let tempDir;
let upstream;
let routerKey;
let POST;
let db;
let repo;
let auth;
let admission;
let seeded;
let waits;
const originalDataDir = process.env.DATA_DIR;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-warm-wait-"));
  process.env.DATA_DIR = tempDir;
  waits = countWaitLines();
  upstream = await startWarmUpstream(WARM_KEY);

  // Each 429 the warm key answers after the first moves its lock a little
  // later, so with many requests the last to resume would run out of the
  // default 10 s and go to the cold key. A longer budget keeps every one waiting.
  process.env.CACHE_AFFINITY_MAX_WAIT_MS = "30000";
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  await db.updateSettings({
    requireApiKey: true,
    enableObservability: true,
    comboStrategies: { kimi: { fallbackStrategy: "fallback" } },
  });
  routerKey = (await db.createApiKey("bench", "bench-machine")).key;
  seeded = await seedWarmCold(db, { baseUrl: `http://127.0.0.1:${upstream.port}/v1`, prefix: "bench", warmKey: WARM_KEY, coldKey: COLD_KEY });

  ({ POST } = await import("../../src/app/api/v1/messages/route.js"));
  repo = await import("@/lib/db/repos/requestDetailsRepo.js");
  auth = await import("@/sse/services/auth.js");
  admission = await import("@/sse/services/memoryAdmission.js");
}, 60_000);

afterAll(async () => {
  waits?.restore();
  for (const res of upstream?.state.held.splice(0) || []) res.destroy();
  await new Promise((r) => (upstream ? upstream.server.close(r) : r()));
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.CACHE_AFFINITY_MAX_WAIT_MS;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const turn = (i, messages) => conversation(i, { messages });

const post = (text) => POST(new Request("http://localhost/v1/messages", {
  method: "POST", headers: claudeCodeHeaders(routerKey), body: socketBody(text), duplex: "half",
}));

// Each conversation's first turn, small, served by the warm key: it is warm for them from now on.
async function prime(from, n) {
  const responses = await Promise.all(Array.from({ length: n }, (_, i) => post(turn(from + i, 3))));
  for (const res of responses) await res.text();
  expect(responses.every((r) => r.status === 200)).toBe(true);
}

// The warm key's next 429 locks it for 8 s (backoff level 3).
async function armWarmKey() {
  const conn = (await db.getProviderConnections({ provider: seeded.nodeId })).find((c) => c.id === seeded.warmId);
  await auth.clearAccountError(seeded.warmId, conn, seeded.model);
  await db.updateProviderConnection(seeded.warmId, { backoffLevel: 2 });
}

async function measure(label, from, n) {
  await armWarmKey();
  await repo.__test__.flush();
  const up = upstream.state;
  up.arm(n);
  waits.reset();
  await settle();
  const m0 = process.memoryUsage();
  const before = heap();
  let peak = before;
  const sampler = setInterval(() => { peak = Math.max(peak, heap()); }, 2);
  const pending = Array.from({ length: n }, (_, i) => post(turn(from + i, MESSAGES)));
  await vi.waitFor(() => expect(waits.count()).toBeGreaterThanOrEqual(n), { timeout: 60_000, interval: 10 });
  clearInterval(sampler);
  peak = Math.max(peak, heap());
  await settle();
  const m1 = process.memoryUsage();
  const held = heap() - before;
  const gate = admission.memoryAdmissionStats();
  // Still all waiting: none has resumed on the warm key yet.
  const valid = up.resumed.length === 0;
  if (process.env.BENCH_SNAPSHOT) v8.writeHeapSnapshot(`${process.env.BENCH_SNAPSHOT}-${label.replace(/\W+/g, "-")}.heapsnapshot`);

  const responses = await Promise.all(pending);
  for (const res of responses) await res.text();
  expect(responses.every((r) => r.status === 200)).toBe(true);
  // Nothing went to the cold key, and each resumed attempt sent the bytes its first one did.
  expect(up.cold).toBe(0);
  expect(up.resumed.toSorted()).toEqual(up.limited.toSorted());
  await repo.__test__.flush();
  await settle();
  return {
    label, n, valid, held, peak: peak - before, after: heap() - before,
    heapUsed: m1.heapUsed - m0.heapUsed, external: m1.external - m0.external,
    gateBytes: gate.heldBytes,
  };
}

// What one parsed body costs on the heap, next to its UTF-8 bytes in a Buffer.
async function bodyCost(text) {
  const keep = [];
  await settle();
  let at = heap();
  keep.push(JSON.parse(text));
  await settle();
  const parsed = heap() - at;
  at = heap();
  keep.push(Buffer.from(text, "utf8"));
  await settle();
  const bytes = heap() - at;
  const t0 = performance.now();
  for (let i = 0; i < 5; i++) JSON.parse(keep[1].toString("utf8"));
  return { parsed, bytes, reparseMs: (performance.now() - t0) / 5 };
}

describe("warm-key wait retention", () => {
  it("measures the memory each request keeps while it waits for a warm key", async () => {
    const text = turn(0, MESSAGES);
    const bodyMb = text.length / MB;
    const cost = await bodyCost(text);
    const warmup = 2;
    await prime(0, warmup + 2 * WAITING);
    await measure("warmup", 0, warmup);
    const rows = [];
    rows.push(await measure("request details default", warmup, WAITING));
    await db.updateSettings({ showSensitiveRequestDetails: true });
    await new Promise((r) => setTimeout(r, 5100));
    rows.push(await measure("full request details on", warmup + WAITING, WAITING));

    const mb = (b) => `${(b / MB).toFixed(2)} MB`;
    const out = [`\n${WAITING} waiting, body ${bodyMb.toFixed(2)} MB of JSON each, ${process.version}`];
    out.push(`one body: parsed ${mb(cost.parsed)}, as UTF-8 bytes ${mb(cost.bytes)}, re-parse ${cost.reparseMs.toFixed(1)} ms`);
    out.push("held: heap + external after a full GC, all requests waiting for their warm key; gate: what memory admission counts for them");
    out.push(`${"scenario".padEnd(26)} ${"held/req".padStart(10)} ${"= bodies".padStart(9)} ${"heap/req".padStart(10)} ${"ext/req".padStart(10)} ${"gate/req".padStart(10)} ${"held".padStart(8)} ${"peak".padStart(8)} ${"after".padStart(7)}`);
    for (const r of rows) {
      const per = r.held / r.n;
      out.push(`${r.label.padEnd(26)} ${mb(per).padStart(10)} ${(per / MB / bodyMb).toFixed(2).padStart(9)} ${mb(r.heapUsed / r.n).padStart(10)} ${mb(r.external / r.n).padStart(10)} ${mb(r.gateBytes / r.n).padStart(10)} ${`${(r.held / MB).toFixed(0)} MB`.padStart(8)} ${`${(r.peak / MB).toFixed(0)} MB`.padStart(8)} ${`${(r.after / MB).toFixed(0)} MB`.padStart(7)}${r.valid ? "" : "  (some resumed before the measure)"}`);
    }
    process.stderr.write(out.join("\n") + "\n");
    expect(rows.every((r) => r.valid)).toBe(true);
  }, 600_000);
});
