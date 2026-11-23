// How much heap each in-flight stream keeps once its response has started.
//
// Drives the real path in-process (POST /v1/messages route → handleChat →
// combo → account selection → chatCore → DefaultExecutor → fetch) against a
// local OpenAI-compatible upstream that answers with SSE headers and a first
// chunk at once, then holds the stream open until the bench ends it. With
// STREAMS requests streaming, it reports the heap they hold after a full GC,
// per stream and against the size of one request body, plus the peak heap
// while they start. Run with request details at their default and with "Show
// full request details" on.
//
//   cd tests && ./node_modules/.bin/vitest run --config vitest.benchmark.config.js bench/stream-retention-benchmark.test.js
//
// BENCH_STREAMS (default 20) sets the concurrent streams. BENCH_SNAPSHOT=<path>
// writes a heap snapshot while they stream (use a small BENCH_STREAMS).
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import v8 from "node:v8";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { claudeCodeBody } from "../helpers/claudeCodeBody.js";
import { heap, settle, socketBody } from "../helpers/heldStreams.js";

const STREAMS = Number(process.env.BENCH_STREAMS || 20);
const MB = 1024 * 1024;
const MODEL = "kimi-k3";

const base = { id: "chatcmpl-bench", object: "chat.completion.chunk", created: 1700000000, model: MODEL };
const chunk = (obj) => `data: ${JSON.stringify({ ...base, ...obj })}\n\n`;

// Responses the upstream has started and not ended.
const open = [];

function startUpstream() {
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hi" }, finish_reason: null }] }));
      open.push(res);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function finishAll() {
  for (const res of open.splice(0)) {
    res.write(chunk({ choices: [{ index: 0, delta: { content: " there" }, finish_reason: null }] }));
    res.write(chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
    res.write(chunk({ choices: [], usage: { prompt_tokens: 250000, completion_tokens: 2, total_tokens: 250002 } }));
    res.end("data: [DONE]\n\n");
  }
}

let tempDir;
let upstream;
let routerKey;
let POST;
let db;
let repo;
const originalDataDir = process.env.DATA_DIR;
const quiet = {};

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-retention-"));
  process.env.DATA_DIR = tempDir;
  for (const k of ["log", "info", "warn", "debug"]) { quiet[k] = console[k]; console[k] = () => {}; }
  upstream = await startUpstream();
  const baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;

  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  await db.updateSettings({
    requireApiKey: true,
    enableObservability: true,
    comboStrategies: { kimi: { fallbackStrategy: "fallback" } },
  });
  routerKey = (await db.createApiKey("bench", "bench-machine")).key;
  const nodeId = "openai-compatible-chat-bench";
  await db.createProviderNode({ id: nodeId, type: "openai-compatible", name: "Bench", prefix: "bench", apiType: "chat", baseUrl });
  await db.createProviderConnection({
    provider: nodeId, authType: "apikey", name: "bench-key", apiKey: "sk-bench-not-a-real-key-000000", isActive: true, testStatus: "active",
    providerSpecificData: { prefix: "bench", apiType: "chat", baseUrl, nodeName: "Bench" },
  });
  await db.createCombo({ name: "kimi", models: [`bench/${MODEL}`] });

  ({ POST } = await import("../../src/app/api/v1/messages/route.js"));
  repo = await import("@/lib/db/repos/requestDetailsRepo.js");
}, 60_000);

afterAll(async () => {
  for (const [k, fn] of Object.entries(quiet)) console[k] = fn;
  for (const res of open.splice(0)) res.destroy();
  await new Promise((r) => upstream?.close(r));
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

// Each request gets its own body text, so nothing is shared between streams
// or with the bench.
const bodyText = (i) => JSON.stringify({ ...claudeCodeBody("kimi", { messages: 90, toolResultChars: 22000 }), metadata: { user_id: `user_bench_${i}` } });


async function measure(label, n) {
  await repo.__test__.flush();
  await settle();
  const before = heap();
  let peak = before;
  const sampler = setInterval(() => { peak = Math.max(peak, heap()); }, 2);
  const responses = await Promise.all(Array.from({ length: n }, (_, i) => POST(new Request("http://localhost/v1/messages", {
    method: "POST", headers: clientHeaders(), body: socketBody(bodyText(i)), duplex: "half",
  }))));
  const readers = responses.map((r) => r.body.getReader());
  // The first bytes reached the client: the stream is under way.
  const firsts = await Promise.all(readers.map((r) => r.read()));
  clearInterval(sampler);
  peak = Math.max(peak, heap());
  expect(responses.every((r) => r.status === 200)).toBe(true);
  expect(firsts.every((f) => !f.done)).toBe(true);
  await settle();
  const held = heap() - before;
  const queued = { ring: repo.__test__.ringSize(), ringBytes: repo.__test__.ringBytes(), queuedBytes: repo.__test__.queuedBytes() };
  if (process.env.BENCH_SNAPSHOT) v8.writeHeapSnapshot(`${process.env.BENCH_SNAPSHOT}-${label.replace(/\W+/g, "-")}.heapsnapshot`);
  // The start rows written, as the 5 s flush does while the replies stream.
  await repo.__test__.flush();
  await settle();
  const written = heap() - before;

  finishAll();
  for (const r of readers) for (;;) if ((await r.read()).done) break;
  await repo.__test__.flush();
  await settle();
  const after = heap() - before;
  return { label, held, written, peak: peak - before, after, queued };
}

describe("stream retention", () => {
  it("measures the heap each in-flight stream keeps after its headers", async () => {
    const bodyMb = bodyText(0).length / MB;
    // Warm up module caches, the DB and the JIT so they don't count.
    await measure("warmup", 2);
    const rows = [];
    rows.push(await measure("request details default", STREAMS));
    await db.updateSettings({ showSensitiveRequestDetails: true });
    await new Promise((r) => setTimeout(r, 5100));
    rows.push(await measure("full request details on", STREAMS));

    const out = [`\n${STREAMS} streams, body ${bodyMb.toFixed(2)} MB of JSON each, request details on ${(await import("@/lib/db/driver.js").then((m) => m.getAdapter())).driver}`];
    out.push("held: heap + external after a full GC, all streams open; written: the same once their start rows are written");
    out.push(`${"scenario".padEnd(26)} ${"held/stream".padStart(12)} ${"= bodies".padStart(9)} ${"written/str".padStart(12)} ${"peak".padStart(9)} ${"after end".padStart(10)}  queued`);
    const mb = (b) => `${(b / MB).toFixed(2)} MB`;
    for (const r of rows) {
      const per = r.held / STREAMS / MB;
      out.push(`${r.label.padEnd(26)} ${mb(r.held / STREAMS).padStart(12)} ${(per / bodyMb).toFixed(2).padStart(9)} ${mb(r.written / STREAMS).padStart(12)} ${`${(r.peak / MB).toFixed(0)} MB`.padStart(9)} ${`${(r.after / MB).toFixed(0)} MB`.padStart(10)}  ring ${r.queued.ring} (${mb(r.queued.ringBytes)}), saves ${mb(r.queued.queuedBytes)}`);
    }
    process.stderr.write(out.join("\n") + "\n");
  }, 600_000);
});
