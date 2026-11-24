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
import v8 from "node:v8";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { claudeCodeBody } from "../helpers/claudeCodeBody.js";
import { claudeCodeHeaders, seedWarmCold } from "../helpers/warmWait.js";

const N = Number(process.env.HERD_N || 300);
const MESSAGES = Number(process.env.HERD_MESSAGES || 1000);
const TOOL_RESULT_CHARS = Number(process.env.HERD_TOOL_RESULT_CHARS || 2000);
const UPSTREAM_MS = Number(process.env.HERD_UPSTREAM_MS || 3000);
const ASCII = process.env.HERD_ASCII === "1";
const NO_LENGTH = process.env.HERD_NO_LENGTH === "1";
const DETAILS = process.env.HERD_DETAILS === "1";
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
const setEnv = (name, value) => {
  savedEnv[name] = process.env[name];
  process.env[name] = value;
};

// An upstream that reads each body, waits, then streams a short reply.
function startSlowUpstream() {
  const state = { requests: 0 };
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      state.requests++;
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
  for (const k of ["log", "info", "warn", "debug"]) console[k] = () => {};
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
    let peak = 0;
    const sample = () => { peak = Math.max(peak, v8.getHeapStatistics().used_heap_size); };
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
      else if (res.status === 200) expect(text).toContain("Done");
      return res.status;
    }));
    clearInterval(sampler);
    sample();

    const counts = {};
    for (const s of statuses) counts[s] = (counts[s] || 0) + 1;
    const gate = admission.memoryAdmissionStats();
    const mb = (b) => `${Math.round(b / MB)} MB`;
    process.stderr.write([
      "",
      `herd: ${N} requests of ${(template.bytes.length / MB).toFixed(2)} MB${ASCII ? "" : " (two-byte text)"}, ${process.version}, upstream ${UPSTREAM_MS} ms`,
      `heap: peak used ${mb(peak)} of ${mb(limit)} limit (${((peak / limit) * 100).toFixed(0)}%)`,
      `replies: ${Object.entries(counts).map(([s, n]) => `${n}× ${s}`).join(", ")} in ${((performance.now() - t0) / 1000).toFixed(1)} s`,
      `gate: admitted ${gate.admitted}, queued ${gate.queued}, refused ${gate.refused}, upstream saw ${upstream.state.requests}`,
      "",
    ].join("\n"));

    expect(statuses.every((s) => s === 200 || s === 503)).toBe(true);
    expect(counts[200] || 0).toBeGreaterThan(0);
    expect(peak).toBeLessThan(limit);
  }, 600_000);
});
