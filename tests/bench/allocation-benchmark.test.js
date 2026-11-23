// How many bytes one request allocates, and where.
//
// Drives the real path in-process (POST /v1/messages route → handleChat →
// combo → account selection → chatCore → DefaultExecutor → fetch) against an
// OpenAI-compatible upstream in a child process (tests/helpers/scriptedUpstream.mjs),
// so its allocations aren't counted. Each request is one large Claude Code
// shaped body; the upstream answers the first K attempts with a 429, so the
// account loop falls back K times, then streams a short reply that the bench
// reads to the end. Request details are written (flushed) inside the window,
// with "Show full request details" off and on.
//
// Allocation is read from V8's sampling heap profiler with objects already
// collected by minor and major GCs included, so it counts garbage too. Bytes
// are V8's scaled estimate; ArrayBuffer and Buffer contents (off the JS heap)
// are not in it.
//
//   cd tests && ./node_modules/.bin/vitest run --config vitest.benchmark.config.js bench/allocation-benchmark.test.js
//
// BENCH_REPS (default 4) requests per scenario; BENCH_K (default "0,2,5") the
// 429 counts; BENCH_BODY_MESSAGES (default 400) the history length.
import { fork } from "node:child_process";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { claudeCodeBody } from "../helpers/claudeCodeBody.js";
import { settle, socketBody } from "../helpers/heldStreams.js";

const REPS = Number(process.env.BENCH_REPS || 4);
const KS = (process.env.BENCH_K || "0,2,5").split(",").map(Number);
const MESSAGES = Number(process.env.BENCH_BODY_MESSAGES || 400);
const ACCOUNTS = Math.max(...KS) + 2;
const MB = 1024 * 1024;
const MODEL = "bench-model";

// Where an allocation is charged: the innermost frame on its stack that
// matches one of these, in this order of preference.
const inFile = (url, name) => url.includes(name);
const SITES = [
  ["preview: measurePreviewSizes", (f) => f === "measurePreviewSizes"],
  ["preview: shorten/check", (f) => f === "shortenPreview" || f === "structuredPreview"],
  ["capping: measureJson/truncateField", (f) => f === "measureJson" || f === "walkJson" || f === "quotedSizes" || f === "truncateField" || f === "prettyJsonPrefix"],
  ["full copy: pack (stringify/buffer/gzip/base64)", (f, u) => inFile(u, "requestDetailsRepo") && (f === "fullCopyBuffer" || f === "packSource" || f === "fullCopySource" || f === "serialize" || f === "put" || f === "packParts")],
  ["row record: stringify", (f) => f === "buildSave" || f === "stringifyJson"],
  ["executor: serialize body", (f, u) => inFile(u, "executors/base") && (f === "serialize" || f === "builtBody")],
  ["executor: encode body (one-shot stream)", (f) => f === "streamedOnce"],
  ["executor: transform/finalize", (f) => f === "prepareSend" || f === "transformRequest" || f === "finalizeBody" || f === "inlineToolChangesWithoutBeta"],
  ["chatCore: translate request", (f) => f === "translateRequest"],
  ["chatCore: attempt copy", (f) => f === "copyBodyForAttempt"],
  ["chatCore: other", (f) => f === "runChatCore"],
  ["account loop / route", (f) => f === "handleChat" || f === "POST" || f === "accountPass"],
];

function charge(profile) {
  const totals = new Map();
  const other = new Map();
  let all = 0;
  const visit = (node, stack) => {
    const fn = node.callFrame.functionName;
    const next = [...stack, { fn, url: node.callFrame.url, line: node.callFrame.lineNumber + 1 }];
    if (node.selfSize) {
      all += node.selfSize;
      let site = "other";
      outer: for (let i = next.length - 1; i >= 0; i--) {
        for (const [name, test] of SITES) if (test(next[i].fn, next[i].url)) { site = name; break outer; }
      }
      // Body reads by undici (fullyReadBody, utf8 decode) and JSON.parse of the client body.
      if (site === "other" && next.some((s) => /fullyReadBody|consumeBody|utf8DecodeBytes/.test(s.fn))) site = "client body read";
      if (process.env.BENCH_DEBUG) {
        const where = `[${site}] ${next.slice(-5).reverse().map((s) => `${s.fn || "(anon)"}@${path.basename(s.url || "")}:${s.line ?? ""}`).join(" < ")}`;
        other.set(where, (other.get(where) || 0) + node.selfSize);
      }
      totals.set(site, (totals.get(site) || 0) + node.selfSize);
    }
    for (const child of node.children) visit(child, next);
  };
  visit(profile.head, []);
  if (process.env.BENCH_DEBUG) {
    const top = [...other].sort((a, b) => b[1] - a[1]).slice(0, 30);
    process.stderr.write(`top stacks:\n${top.map(([w, b]) => `  ${(b / MB).toFixed(2)} ${w}`).join("\n")}\n`);
  }
  return { all, totals };
}

let tempDir;
let upstream;
let routerKey;
let POST;
let db;
let repo;
let auth;
let session;
let served = [];
const originalDataDir = process.env.DATA_DIR;
const quiet = {};

function send(msg) {
  return new Promise((resolve) => {
    const onMsg = (m) => { if (m.ack) { upstream.off("message", onMsg); resolve(); } };
    upstream.on("message", onMsg);
    upstream.send(msg);
  });
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-alloc-"));
  process.env.DATA_DIR = tempDir;
  for (const k of ["log", "info", "warn", "debug", "error"]) { quiet[k] = console[k]; console[k] = () => {}; }
  upstream = fork(fileURLToPath(new URL("../helpers/scriptedUpstream.mjs", import.meta.url)), [], { env: { ...process.env, UPSTREAM_MODEL: MODEL } });
  const port = await new Promise((resolve) => upstream.on("message", (m) => { if (m.port) resolve(m.port); }));
  upstream.on("message", (m) => { if (m.served !== undefined) served.push(m); });
  const baseUrl = `http://127.0.0.1:${port}/v1`;

  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  await db.updateSettings({
    requireApiKey: true,
    enableObservability: true,
    comboStrategies: { bench: { fallbackStrategy: "fallback" } },
  });
  routerKey = (await db.createApiKey("bench", "bench-machine")).key;
  const nodeId = "openai-compatible-chat-bench";
  await db.createProviderNode({ id: nodeId, type: "openai-compatible", name: "Bench", prefix: "bench", apiType: "chat", baseUrl });
  for (let i = 0; i < ACCOUNTS; i++) {
    await db.createProviderConnection({
      provider: nodeId, authType: "apikey", name: `bench-key-${i}`, apiKey: `sk-bench-not-a-real-key-${String(i).padStart(6, "0")}`, isActive: true, testStatus: "active",
      providerSpecificData: { prefix: "bench", apiType: "chat", baseUrl, nodeName: "Bench" },
    });
  }
  await db.createCombo({ name: "bench", models: [`bench/${MODEL}`] });

  ({ POST } = await import("../../src/app/api/v1/messages/route.js"));
  repo = await import("@/lib/db/repos/requestDetailsRepo.js");
  auth = await import("@/sse/services/auth.js");
  session = new Session();
  session.connect();
  await session.post("HeapProfiler.enable");
}, 60_000);

afterAll(async () => {
  for (const [k, fn] of Object.entries(quiet)) console[k] = fn;
  session?.disconnect();
  upstream?.kill();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const clientHeaders = () => ({
  "content-type": "application/json",
  "user-agent": "claude-cli/2.1.0 (external, cli)",
  "x-api-key": routerKey,
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14",
  "x-app": "cli",
});

const bodyText = (i) => JSON.stringify({ ...claudeCodeBody("bench", { messages: MESSAGES, tools: 48, toolResultChars: 13000 }), metadata: { user_id: `user_bench_${i}` } });

// Unlock every account a 429 locked, outside the measured window.
async function unlockAll() {
  const conns = await db.getProviderConnections({ provider: "openai-compatible-chat-bench" });
  for (const c of conns) await auth.clearAccountError(c.id, c, MODEL);
}

let seq = 0;
async function oneRequest(k, profile) {
  await unlockAll();
  await repo.__test__.flush();
  const text = bodyText(seq++);
  const body = socketBody(text);
  await send({ fail: k });
  served = [];
  await settle();
  if (profile) await session.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  const res = await POST(new Request("http://localhost/v1/messages", { method: "POST", headers: clientHeaders(), body, duplex: "half" }));
  const reader = res.body.getReader();
  for (;;) if ((await reader.read()).done) break;
  // The stream's end save is queued once the reply is read; write it and the error rows.
  await new Promise((r) => setTimeout(r, 20));
  await repo.__test__.flush();
  const result = profile ? (await session.post("HeapProfiler.stopSampling")).profile : null;
  expect(res.status).toBe(200);
  expect(served.map((s) => s.status)).toEqual([...Array(k).fill(429), 200]);
  // Every attempt got the whole body, resent or not.
  expect(new Set(served.map((s) => s.served)).size).toBe(1);
  expect(served[0].served).toBeGreaterThan(text.length / 2);
  return { text, result };
}

async function scenario(label, k) {
  await oneRequest(k, false);
  const runs = [];
  for (let i = 0; i < REPS; i++) runs.push(charge((await oneRequest(k, true)).result));
  const sites = new Map();
  for (const r of runs) for (const [s, b] of r.totals) sites.set(s, (sites.get(s) || 0) + b / runs.length);
  return { label, k, all: runs.reduce((a, r) => a + r.all, 0) / runs.length, sites };
}

describe("allocation per request", () => {
  it("measures bytes allocated per request across 429 fallbacks", async () => {
    const bodyMb = bodyText(0).length / MB;
    await oneRequest(0, false);
    const rows = [];
    for (const k of KS) rows.push(await scenario("details default", k));
    await db.updateSettings({ showSensitiveRequestDetails: true });
    await new Promise((r) => setTimeout(r, 5100));
    for (const k of KS) rows.push(await scenario("full details on", k));
    // The full copies were made and stored, so the packer's numbers are real.
    const latest = (await db.getRequestDetails({ pageSize: 6 })).details;
    // The last request's rows: its K error rows and its reply's.
    expect(latest.slice(0, KS.at(-1) + 1).map((d) => d.hasFullData)).toEqual(Array(KS.at(-1) + 1).fill(true));
    expect((await db.getRequestDetailFullData(latest[0].id)).request.messages).toHaveLength(MESSAGES);

    const out = [`\nbody ${bodyMb.toFixed(2)} MB of JSON, ${REPS} requests per row, ${process.version}`];
    const siteNames = [...new Set(rows.flatMap((r) => [...r.sites.keys()]))]
      .sort((a, b) => rows.reduce((s, r) => s + (r.sites.get(b) || 0), 0) - rows.reduce((s, r) => s + (r.sites.get(a) || 0), 0));
    out.push(`${"scenario".padEnd(20)} ${"K".padStart(2)} ${"total MB".padStart(9)}  per site (MB)`);
    for (const r of rows) {
      out.push(`${r.label.padEnd(20)} ${String(r.k).padStart(2)} ${(r.all / MB).toFixed(1).padStart(9)}`);
      for (const s of siteNames) {
        const b = r.sites.get(s) || 0;
        if (b >= 0.05 * MB) out.push(`${"".padEnd(34)}${(b / MB).toFixed(1).padStart(7)}  ${s}`);
      }
    }
    process.stderr.write(out.join("\n") + "\n");
    if (process.env.BENCH_JSON) fs.writeFileSync(process.env.BENCH_JSON, JSON.stringify(rows.map((r) => ({ ...r, sites: Object.fromEntries(r.sites) })), null, 2));
  }, 900_000);
});
