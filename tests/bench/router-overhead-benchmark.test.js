// How much time 10router itself adds to a request, upstream excluded.
//
// Drives the real path in-process (POST /v1/messages route → handleChat →
// combo → account selection → chatCore → DefaultExecutor → fetch) against a
// local upstream that answers instantly, with a Claude Code sized body, a real
// SQLite DB and observability on with full request details. Compares against
// a direct fetch of the same upstream, so what is left is the router's cost.
//
//   cd tests && ./node_modules/.bin/vitest run --config vitest.benchmark.config.js bench/router-overhead-benchmark.test.js
//
// BENCH_ITER (default 30) sets the measured iterations per scenario.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const ITER = Number(process.env.BENCH_ITER || 30);
const WARMUP = 4;
const CHUNKS = 2000;
const MODEL = "claude-opus-5-5";
const KIMI = "kimi-k3";
// Settings → observability "max JSON size" in KB; unset keeps the default
// (128 KB per field once full request details are shown).
const MAX_JSON_KB = Number(process.env.BENCH_MAX_JSON_KB || 0);

// ---- A Claude Code shaped request -----------------------------------------

function lorem(n, seed) {
  const words = ["const", "function", "return", "await", "import", "export", "value", "result", "error", "stream", "request", "provider", "model", "token", "buffer", "handler"];
  let out = "";
  let x = seed * 2654435761 >>> 0;
  while (out.length < n) {
    x = (x * 1103515245 + 12345) >>> 0;
    out += words[x % words.length] + ((x >> 8) % 9 === 0 ? ";\n" : " ");
  }
  return out.slice(0, n);
}

function toolSchema(i) {
  const props = {};
  for (let p = 0; p < 6; p++) {
    props[`param_${p}`] = { type: p % 2 ? "string" : "number", description: lorem(120, i * 10 + p) };
  }
  props.options = { type: "object", properties: { mode: { type: "string", enum: ["a", "b", "c"] }, deep: { type: "array", items: { type: "string" } } } };
  return { name: `Tool${i}`, description: lorem(900, i), input_schema: { type: "object", properties: props, required: ["param_0"], additionalProperties: false, $schema: "http://json-schema.org/draft-07/schema#" } };
}

export function claudeCodeBody(model, { messages = 50, tools = 17, toolResultChars = Number(process.env.BENCH_TOOL_RESULT_CHARS || 13000) } = {}) {
  const msgs = [{ role: "user", content: [{ type: "text", text: "<system-reminder>" + lorem(4000, 1) + "</system-reminder>" }, { type: "text", text: "Fix the bug in the stream handler." }] }];
  for (let i = 1; msgs.length < messages - 1; i++) {
    const id = `toolu_01${String(i).padStart(22, "0")}`;
    msgs.push({ role: "assistant", content: [
      { type: "thinking", thinking: lorem(600, i + 100), signature: "Eq" + "A".repeat(400) },
      { type: "text", text: lorem(200, i + 200) },
      { type: "tool_use", id, name: `Tool${i % tools}`, input: { param_0: i, param_1: lorem(80, i), options: { mode: "a" } } },
    ] });
    msgs.push({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: lorem(toolResultChars, i + 300) }] }] });
  }
  msgs.push({ role: "user", content: [{ type: "text", text: "Now run the tests.", cache_control: { type: "ephemeral" } }] });
  return {
    model,
    max_tokens: 32000,
    stream: true,
    thinking: { type: "enabled", budget_tokens: 31999 },
    metadata: { user_id: "user_bench_account__session_00000000-0000-0000-0000-000000000000" },
    system: [
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: "ephemeral" } },
      { type: "text", text: lorem(12000, 7), cache_control: { type: "ephemeral" } },
    ],
    tools: Array.from({ length: tools }, (_, i) => toolSchema(i)),
    messages: msgs,
  };
}

// ---- Instant upstream --------------------------------------------------------

function claudeSse(chunks) {
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const out = [ev("message_start", { message: { id: "msg_bench", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, usage: { input_tokens: 90000, output_tokens: 1, cache_read_input_tokens: 80000, cache_creation_input_tokens: 500 } } })];
  const thinking = Math.floor(chunks * 0.1);
  out.push(ev("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }));
  for (let i = 0; i < thinking; i++) out.push(ev("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "let me think " } }));
  out.push(ev("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "Eq" + "B".repeat(300) } }));
  out.push(ev("content_block_stop", { index: 0 }));
  out.push(ev("content_block_start", { index: 1, content_block: { type: "text", text: "" } }));
  for (let i = thinking; i < chunks; i++) out.push(ev("content_block_delta", { index: 1, delta: { type: "text_delta", text: "word " } }));
  out.push(ev("content_block_stop", { index: 1 }));
  out.push(ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: chunks } }));
  out.push(ev("message_stop", {}));
  return out;
}

function openaiSse(chunks) {
  const base = { id: "chatcmpl-bench", object: "chat.completion.chunk", created: 1700000000, model: KIMI };
  const d = (obj) => `data: ${JSON.stringify({ ...base, ...obj })}\n\n`;
  const out = [d({ choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })];
  const thinking = Math.floor(chunks * 0.1);
  for (let i = 0; i < thinking; i++) out.push(d({ choices: [{ index: 0, delta: { reasoning_content: "let me think " }, finish_reason: null }] }));
  for (let i = thinking; i < chunks; i++) out.push(d({ choices: [{ index: 0, delta: { content: "word " }, finish_reason: null }] }));
  out.push(d({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
  out.push(d({ choices: [], usage: { prompt_tokens: 90000, completion_tokens: chunks, total_tokens: 90000 + chunks, prompt_tokens_details: { cached_tokens: 80000 } } }));
  out.push("data: [DONE]\n\n");
  return out;
}

const SSE = { claude: claudeSse(CHUNKS), openai: openaiSse(CHUNKS) };

function startUpstream() {
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      const events = req.url.endsWith("/messages") ? SSE.claude : SSE.openai;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const e of events) res.write(e);
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// ---- Harness -----------------------------------------------------------------

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const p90 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))]; };
const fmt = (n) => n.toFixed(2).padStart(8);

async function readTimed(response, t0) {
  const reader = response.body.getReader();
  let ttfb = null;
  let bytes = 0;
  const parts = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (ttfb === null) ttfb = performance.now() - t0;
    bytes += value.length;
    parts.push(value);
  }
  return { ttfb, total: performance.now() - t0, bytes, text: Buffer.concat(parts).toString("utf8") };
}

// Longest stretch the event loop could not run anything else.
function blockMeter() {
  let last = performance.now();
  let max = 0;
  let on = true;
  const tick = () => {
    const now = performance.now();
    if (now - last > max) max = now - last;
    last = now;
    if (on) setImmediate(tick);
  };
  setImmediate(tick);
  return () => { on = false; return max; };
}

let tempDir;
let upstream;
let baseUrl;
let routerKey;
let POST;
let repo;
const originalDataDir = process.env.DATA_DIR;
const quiet = {};

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-overhead-"));
  process.env.DATA_DIR = tempDir;
  for (const k of ["log", "info", "warn", "debug"]) { quiet[k] = console[k]; console[k] = () => {}; }
  upstream = await startUpstream();
  baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;

  vi.resetModules();
  const db = await import("@/lib/db/index.js");
  await db.initDb();
  await db.updateSettings({
    requireApiKey: true,
    enableObservability: true,
    showSensitiveRequestDetails: true,
    comboStrategies: { opus: { fallbackStrategy: "fallback" }, kimi: { fallbackStrategy: "fallback" } },
    comboStickyRoundRobinLimit: 3,
    // Flush only when the bench asks, so each flush is timed on its own.
    observabilityBatchSize: 100000,
    observabilityFlushIntervalMs: 3_600_000,
    ...(MAX_JSON_KB ? { observabilityMaxJsonSize: MAX_JSON_KB } : {}),
  });
  routerKey = (await db.createApiKey("bench", "bench-machine")).key;
  const nodeId = "openai-compatible-chat-bench";
  const modelRoutes = { [MODEL]: "anthropic" };
  await db.createProviderNode({ id: nodeId, type: "openai-compatible", name: "Bench", prefix: "bench", apiType: "chat", baseUrl, modelRoutes });
  await db.createProviderConnection({
    provider: nodeId, authType: "apikey", name: "bench-key", apiKey: "sk-bench-not-a-real-key-000000", isActive: true, testStatus: "active",
    providerSpecificData: { prefix: "bench", apiType: "chat", baseUrl, nodeName: "Bench", modelRoutes },
  });
  await db.createCombo({ name: "opus", models: [`bench/${MODEL}`] });
  await db.createCombo({ name: "kimi", models: [`bench/${KIMI}`] });

  ({ POST } = await import("../../src/app/api/v1/messages/route.js"));
  repo = await import("@/lib/db/repos/requestDetailsRepo.js");
}, 60_000);

afterAll(async () => {
  for (const [k, fn] of Object.entries(quiet)) console[k] = fn;
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

// Optional phase marks: a local patch can call globalThis.__bm?.("name") along
// the path; each request then reports the time between consecutive marks.
async function viaRouter(bodyStr) {
  const request = new Request("http://localhost/v1/messages", { method: "POST", headers: clientHeaders(), body: bodyStr });
  const marks = [];
  globalThis.__bm = (name) => marks.push([name, performance.now()]);
  const t0 = performance.now();
  marks.push(["t0", t0]);
  const response = await POST(request);
  const headersAt = performance.now() - t0;
  marks.push(["route:returned", performance.now()]);
  const r = await readTimed(response, t0);
  marks.push(["client:firstByte", t0 + r.ttfb]);
  marks.push(["client:done", t0 + r.total]);
  marks.sort((a, b) => a[1] - b[1]);
  delete globalThis.__bm;
  return { ...r, headersAt, status: response.status, marks };
}

function phaseTable(rows) {
  const per = new Map();
  for (const { marks } of rows) {
    if (!marks || marks.length <= 4) return null;
    for (let i = 1; i < marks.length; i++) {
      const key = `${marks[i - 1][0]} → ${marks[i][0]}`;
      if (!per.has(key)) per.set(key, { order: i, xs: [] });
      per.get(key).xs.push(marks[i][1] - marks[i - 1][1]);
    }
  }
  return [...per.entries()].sort((a, b) => a[1].order - b[1].order).map(([k, v]) => [k, median(v.xs)]);
}

async function direct(bodyStr, route) {
  const t0 = performance.now();
  const response = await fetch(`${baseUrl}${route}`, { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" }, body: bodyStr });
  return { ...(await readTimed(response, t0)), headersAt: 0 };
}

async function run(label, fn) {
  for (let i = 0; i < WARMUP; i++) await fn();
  const rows = [];
  for (let i = 0; i < ITER; i++) rows.push(await fn());
  // Request details buffer: flush between scenarios so one scenario's backlog
  // never lands inside another's timing.
  await repo.__test__.flush();
  return { label, phases: phaseTable(rows), ttfb: median(rows.map((r) => r.ttfb)), ttfbP90: p90(rows.map((r) => r.ttfb)), total: median(rows.map((r) => r.total)), headers: median(rows.map((r) => r.headersAt)), sample: rows[0] };
}

describe("router overhead", () => {
  it("measures TTFB, per-chunk and post-completion costs", async () => {
    const bodies = {
      claude: JSON.stringify(claudeCodeBody("opus")),
      openai: JSON.stringify(claudeCodeBody("kimi")),
    };
    const kb = Math.round(bodies.claude.length / 1024);

    const results = [];
    results.push(await run("direct /messages", () => direct(bodies.claude, "/messages")));
    results.push(await run("router claude→claude", () => viaRouter(bodies.claude)));
    results.push(await run("direct /chat/completions", () => direct(bodies.openai, "/chat/completions")));
    results.push(await run("router claude→openai", () => viaRouter(bodies.openai)));

    for (const r of results) expect(r.sample.bytes).toBeGreaterThan(0);
    expect(results[1].sample.status).toBe(200);
    expect(results[1].sample.text).toContain("message_stop");
    expect(results[3].sample.text).toContain("message_stop");

    // Post-completion: a streaming request writes two request-detail rows under
    // one id, one when the stream starts and one when it ends. In prod the 5s
    // flush timer usually lands between them ("split"); a short stream can put
    // both in one flush ("same batch").
    const timedFlush = async () => {
      // Let the request's own tail (usage rows, endpoint log) finish first, so
      // only the flush is timed.
      await new Promise((r) => setTimeout(r, 50));
      const stop = blockMeter();
      const elu = performance.eventLoopUtilization();
      const t0 = performance.now();
      await repo.__test__.flush();
      await new Promise((r) => setImmediate(r));
      return { wall: performance.now() - t0, busy: performance.eventLoopUtilization(elu).active, block: stop() };
    };
    const flushes = { start: [], end: [], same: [] };
    for (let i = 0; i < 7; i++) {
      const response = await POST(new Request("http://localhost/v1/messages", { method: "POST", headers: clientHeaders(), body: bodies.claude }));
      flushes.start.push(await timedFlush());
      await readTimed(response, performance.now());
      flushes.end.push(await timedFlush());
      await viaRouter(bodies.claude);
      flushes.same.push(await timedFlush());
    }

    const out = [];
    out.push(`\nbody ${kb} KB, ${CHUNKS} SSE events, ${ITER} iterations (median)`);
    out.push(`${"scenario".padEnd(26)}  ${"headers".padStart(8)} ${"TTFB".padStart(8)} ${"TTFB p90".padStart(8)} ${"total".padStart(8)}`);
    for (const r of results) out.push(`${r.label.padEnd(26)}  ${fmt(r.headers)} ${fmt(r.ttfb)} ${fmt(r.ttfbP90)} ${fmt(r.total)}`);
    const add = (a, b) => ({ ttfb: results[a].ttfb - results[b].ttfb, total: results[a].total - results[b].total });
    const pass = add(1, 0);
    const tr = add(3, 2);
    out.push(`router adds (claude→claude): TTFB ${pass.ttfb.toFixed(2)} ms, stream ${(pass.total - pass.ttfb).toFixed(2)} ms = ${((pass.total - pass.ttfb) / CHUNKS * 1000).toFixed(1)} µs/event`);
    out.push(`router adds (claude→openai): TTFB ${tr.ttfb.toFixed(2)} ms, stream ${(tr.total - tr.ttfb).toFixed(2)} ms = ${((tr.total - tr.ttfb) / CHUNKS * 1000).toFixed(1)} µs/event`);
    out.push(`\nrequest-details flush, cap ${MAX_JSON_KB ? `${MAX_JSON_KB} KB` : "default"} (median of 7)    wall     busy  longest block`);
    for (const [k, label] of [["start", "split: start row"], ["end", "split: complete row"], ["same", "same batch: both rows"]]) {
      const xs = flushes[k];
      out.push(`  ${label.padEnd(40)} ${fmt(median(xs.map((b) => b.wall)))} ${fmt(median(xs.map((b) => b.busy)))} ${fmt(median(xs.map((b) => b.block)))}`);
    }
    for (const r of results) {
      if (!r.phases) continue;
      out.push(`\nphases, ${r.label} (median ms)`);
      for (const [k, v] of r.phases) if (v >= 0.05) out.push(`  ${k.padEnd(52)} ${fmt(v)}`);
    }
    process.stderr.write(out.join("\n") + "\n");
  }, 600_000);
});
