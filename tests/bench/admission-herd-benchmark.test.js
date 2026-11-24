// A restart herd: N clients send their big Claude Code conversations at once.
//
// Drives the real path in-process (POST /v1/messages route → handleChat →
// memory admission → combo → account loop → chatCore → DefaultExecutor →
// fetch) against a slow local OpenAI-compatible upstream, and samples the V8
// heap the whole time. Without a heap-aware gate, the requests it admits
// together hold more heap than the process has, and V8 aborts ("JavaScript
// heap out of memory"), which kills this run. With one, every request gets a
// reply or a 503 with Retry-After, and the heap stays under its limit.
//
// Run it under the heap limit to test, e.g. production's default:
//
//   cd tests && NODE_OPTIONS=--max-old-space-size=1048 ./node_modules/.bin/vitest run \
//     --config vitest.benchmark.config.js bench/admission-herd-benchmark.test.js
//
// HERD_N (default 300) concurrent requests, HERD_MESSAGES (1000) messages
// each, HERD_TOOL_RESULT_CHARS (2000) per tool result (about 2 MB of JSON
// a request), HERD_UPSTREAM_MS (3000) before the upstream answers. Each body
// has a non-Latin-1 character, as most real ones do, so V8 holds its text two
// bytes per character (HERD_ASCII=1 turns that off). MEMORY_HIGH_WATER_MB
// defaults to 1638 here (0.8 of a 2 GiB container), as in production.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PerformanceObserver, constants as perfConstants } from "node:perf_hooks";
import v8 from "node:v8";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { claudeCodeBody } from "../helpers/claudeCodeBody.js";
import { settle } from "../helpers/heldStreams.js";
import { claudeCodeHeaders, seedWarmCold } from "../helpers/warmWait.js";

const N = Number(process.env.HERD_N || 300);
const MESSAGES = Number(process.env.HERD_MESSAGES || 1000);
const TOOL_RESULT_CHARS = Number(process.env.HERD_TOOL_RESULT_CHARS || 2000);
const UPSTREAM_MS = Number(process.env.HERD_UPSTREAM_MS || 3000);
const ASCII = process.env.HERD_ASCII === "1";
const NO_LENGTH = process.env.HERD_NO_LENGTH === "1";
const DETAILS = process.env.HERD_DETAILS === "1";
const LIMIT_FIRST = Number(process.env.HERD_429 || 0);
const MB = 1024 * 1024;
const KEY_A = "sk-herd-a-not-a-real-key-000000000";
const KEY_B = "sk-herd-b-not-a-real-key-000000000";
// Fixed width, so every body has the same length.
const MARK = "@@HERD-ID@@";

let tempDir;
let upstream;
let routerKey;
let POST;
let admission;
const savedEnv = {};
const savedConsole = {};
const setEnv = (name, value) => {
  savedEnv[name] = process.env[name];
  process.env[name] = value;
};

// An upstream that reads each body, waits, then streams a short reply. With
// HERD_429 set, each conversation's first HERD_429 attempts get a 429 at once,
// so requests fall back across the two keys and wait for them, as under load.
const CONVERSATION = Buffer.from("conversation ");
function startSlowUpstream() {
  const state = { requests: 0, limited: 0 };
  const attempts = new Map();
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on("data", (part) => { if (LIMIT_FIRST > 0) parts.push(part); });
    req.on("end", () => {
      state.requests++;
      let head = null;
      if (parts.length) {
        const bytes = Buffer.concat(parts);
        const at = bytes.indexOf(CONVERSATION);
        if (at >= 0) head = bytes.subarray(at, at + CONVERSATION.length + MARK.length).toString();
      }
      const n = (attempts.get(head) || 0) + 1;
      attempts.set(head, n);
      if (head && n <= LIMIT_FIRST) {
        state.limited++;
        res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
        res.end(JSON.stringify({ error: { message: "Too many requests", type: "requests", code: "429" } }));
        return;
      }
      setTimeout(() => {
        const base = { id: "chatcmpl-herd", object: "chat.completion.chunk", created: 1700000000, model: "kimi-k3" };
        const chunk = (obj) => `data: ${JSON.stringify({ ...base, ...obj })}\n\n`;
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Done" }, finish_reason: null }] }));
        setTimeout(() => {
          res.write(chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
          res.write(chunk({ choices: [], usage: { prompt_tokens: 250000, completion_tokens: 1, total_tokens: 250001 } }));
          res.end("data: [DONE]\n\n");
        }, 200);
      }, UPSTREAM_MS);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, state, port: server.address().port })));
}

// One body's bytes, shared by every request, with MARK where each puts its id.
function herdTemplate() {
  const body = claudeCodeBody("kimi", { messages: MESSAGES, tools: 24, toolResultChars: TOOL_RESULT_CHARS });
  body.messages[0].content[1].text = `Fix the bug in the stream handler, conversation ${MARK}.`;
  body.metadata = { user_id: `user_herd_account__session_${MARK}-0000-0000-0000-000000000000` };
  if (!ASCII) body.messages[2].content[0].content[0].text += " — done";
  const bytes = Buffer.from(JSON.stringify(body), "utf8");
  const marks = [];
  for (let at = bytes.indexOf(MARK); at >= 0; at = bytes.indexOf(MARK, at + 1)) marks.push(at);
  return { bytes, marks };
}

// Request `i`'s body as Next hands it over: read off the socket in 64 KB
// parts, so nothing holds a whole copy before the route reads it.
function herdBody({ bytes, marks }, i) {
  const id = Buffer.from(String(i).padStart(MARK.length, "0"));
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      const end = Math.min(offset + 64 * 1024, bytes.length);
      const part = Buffer.from(bytes.subarray(offset, end));
      for (const at of marks) {
        if (at + MARK.length > offset && at < end) {
          for (let k = 0; k < MARK.length; k++) {
            const pos = at + k - offset;
            if (pos >= 0 && pos < part.length) part[pos] = id[k];
          }
        }
      }
      controller.enqueue(part);
      offset = end;
      if (offset >= bytes.length) controller.close();
    },
  });
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-herd-"));
  setEnv("DATA_DIR", tempDir);
  if (process.env.MEMORY_HIGH_WATER_MB === undefined) setEnv("MEMORY_HIGH_WATER_MB", "1638");
  upstream = await startSlowUpstream();
  for (const k of ["log", "info", "warn", "debug"]) {
    savedConsole[k] = console[k];
    console[k] = () => {};
  }
  vi.resetModules();
  const db = await import("@/lib/db/index.js");
  await db.initDb();
  await db.updateSettings({
    requireApiKey: true,
    comboStrategies: { kimi: { fallbackStrategy: "fallback" } },
    ...(DETAILS ? { enableObservability: true, showSensitiveRequestDetails: true } : {}),
  });
  routerKey = (await db.createApiKey("herd", "herd-machine")).key;
  await seedWarmCold(db, { baseUrl: `http://127.0.0.1:${upstream.port}/v1`, prefix: "herd", warmKey: KEY_A, coldKey: KEY_B });
  ({ POST } = await import("../../src/app/api/v1/messages/route.js"));
  admission = await import("@/sse/services/memoryAdmission.js");
}, 60_000);

afterAll(async () => {
  Object.assign(console, savedConsole);
  await new Promise((r) => (upstream ? upstream.server.close(r) : r()));
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("restart herd", () => {
  it("answers every request or refuses it with a 503, and keeps the heap under its limit", async () => {
    const template = herdTemplate();
    const limit = v8.getHeapStatistics().heap_size_limit;
    await settle();
    const base = v8.getHeapStatistics().used_heap_size;
    const baseRss = process.memoryUsage.rss();
    // Sampled between tasks: the synchronous parse/translate/serialize of a
    // body runs in one task, so a sample can't land inside one.
    const m = { used: 0, rss: 0, committed: 0, live: 0, inflight: 0, perInflight: 0, rssPerInflight: 0 };
    const sample = () => {
      const h = v8.getHeapStatistics();
      const inflight = admission.memoryAdmissionStats().inflight;
      m.used = Math.max(m.used, h.used_heap_size);
      m.committed = Math.max(m.committed, h.total_heap_size);
      m.rss = Math.max(m.rss, process.memoryUsage.rss());
      m.inflight = Math.max(m.inflight, inflight);
      // While the herd is all in: later, garbage outlives the requests that made it.
      if (inflight >= m.inflight * 0.9 && inflight > 0) m.rssPerInflight = Math.max(m.rssPerInflight, (process.memoryUsage.rss() - baseRss) / inflight);
    };
    // What a mark-compact leaves: the live heap, which is what V8 runs out of.
    const gcs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.detail?.kind !== perfConstants.NODE_PERFORMANCE_GC_MAJOR) continue;
        const used = v8.getHeapStatistics().used_heap_size;
        const inflight = admission.memoryAdmissionStats().inflight;
        m.live = Math.max(m.live, used);
        if (inflight >= m.inflight * 0.9 && inflight > 0) m.perInflight = Math.max(m.perInflight, (used - base) / inflight);
      }
    });
    gcs.observe({ entryTypes: ["gc"] });
    const sampler = setInterval(sample, 2);
    const t0 = performance.now();

    const statuses = await Promise.all(Array.from({ length: N }, async (_, i) => {
      const res = await POST(new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { ...claudeCodeHeaders(routerKey), ...(NO_LENGTH ? {} : { "content-length": String(template.bytes.length) }) },
        body: herdBody(template, i),
        duplex: "half",
      }));
      const text = await res.text();
      sample();
      if (res.status === 503) expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
      // A reply that went out early (early headers) ends in an error frame when
      // routing then fails: with HERD_429, both keys locked.
      if (res.status === 200 && !text.includes("Done")) return LIMIT_FIRST > 0 && text.includes("error") ? "200 with an error frame" : "200 without an answer";
      return res.status;
    }));
    clearInterval(sampler);
    gcs.disconnect();
    sample();

    const counts = {};
    for (const s of statuses) counts[s] = (counts[s] || 0) + 1;
    const gate = admission.memoryAdmissionStats();
    const body = template.bytes.length;
    const mb = (b) => `${Math.round(b / MB)} MB`;
    const pct = (b) => `${((b / limit) * 100).toFixed(0)}%`;
    process.stderr.write([
      "",
      `herd: ${N} requests of ${(body / MB).toFixed(2)} MB${ASCII ? "" : " (two-byte text)"}${NO_LENGTH ? ", no Content-Length" : ""}${LIMIT_FIRST ? `, first ${LIMIT_FIRST} attempt(s) of each 429` : ""}, ${process.version}, upstream ${UPSTREAM_MS} ms`,
      `heap: limit ${mb(limit)}, base ${mb(base)}, peak used ${mb(m.used)} (${pct(m.used)}), peak live after a mark-compact ${mb(m.live)} (${pct(m.live)}), peak committed ${mb(m.committed)}`,
      `rss: base ${mb(baseRss)}, peak ${mb(m.rss)}`,
      `per request in flight (most of the herd in): up to ${(m.perInflight / MB).toFixed(1)} MB of live heap (${(m.perInflight / body).toFixed(1)}× its body) and ${(m.rssPerInflight / MB).toFixed(1)} MB of rss (${(m.rssPerInflight / body).toFixed(1)}×) over base; up to ${m.inflight} in flight at once`,
      `replies: ${Object.entries(counts).map(([s, n]) => `${n}× ${s}`).join(", ")} in ${((performance.now() - t0) / 1000).toFixed(1)} s`,
      `gate: admitted ${gate.admitted}, queued ${gate.queued}, refused ${gate.refused}; upstream saw ${upstream.state.requests} (${upstream.state.limited} answered 429)`,
      "",
    ].join("\n"));

    // With HERD_429, a request can find both keys locked and get the 429 itself
    // (or, once its headers went out early, as an error frame).
    expect(statuses.every((s) => s === 200 || s === 503 || (LIMIT_FIRST > 0 && (s === 429 || s === "200 with an error frame")))).toBe(true);
    expect(counts[200] || 0).toBeGreaterThan(0);
    // The scenario ran as named: the upstream did answer 429s, and V8 did collect.
    if (LIMIT_FIRST > 0) expect(upstream.state.limited).toBeGreaterThan(0);
    expect(m.live).toBeGreaterThan(0);
    // Healthy: the live heap stayed well clear of the limit, and resident
    // memory under HERD_MAX_RSS_MB when that is set.
    expect(m.live / limit).toBeLessThan(Number(process.env.HERD_MAX_LIVE_PCT || 85) / 100);
    if (process.env.HERD_MAX_RSS_MB) expect(m.rss).toBeLessThan(Number(process.env.HERD_MAX_RSS_MB) * MB);
  }, 600_000);
});
