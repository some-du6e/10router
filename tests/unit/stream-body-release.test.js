// Once a streamed reply has started, nothing is sent upstream again, so no copy
// of the prompt may stay in memory while it streams (10-300 s for a coding
// agent): not the client's body, the translated body, the string sent upstream
// (which undici kept as its request's source), nor anything the stream's
// callbacks, the early-headers abort listener or request details close over.
// Driven through the real /v1/messages route to an OpenAI-compatible upstream
// that holds its streams open. The rows request details keep for them must
// still record the request.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { heap, settle, socketBody } from "../helpers/heldStreams.js";

const MB = 1024 * 1024;
const STREAMS = 4;
const MODEL = "kimi-k3";
const chunk = (obj) => `data: ${JSON.stringify({ id: "chatcmpl-t", object: "chat.completion.chunk", created: 1, model: MODEL, ...obj })}\n\n`;

let server;
let tempDir;
let routerKey;
let POST;
let db;
let repo;
const open = [];
const received = [];
const originalDataDir = process.env.DATA_DIR;
const quiet = {};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let bytes = 0;
    req.on("data", (c) => { bytes += c.length; });
    req.on("end", () => {
      received.push({ bytes, length: Number(req.headers["content-length"]), chunked: req.headers["transfer-encoding"] === "chunked" });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hi" }, finish_reason: null }] }));
      open.push(res);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-body-release-"));
  process.env.DATA_DIR = tempDir;
  for (const k of ["log", "info", "warn", "debug"]) { quiet[k] = console[k]; console[k] = () => {}; }
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  await db.updateSettings({ requireApiKey: true, enableObservability: true, observabilityBatchSize: 1000, observabilityFlushIntervalMs: 3_600_000 });
  routerKey = (await db.createApiKey("test", "test-machine")).key;
  const nodeId = "openai-compatible-chat-release";
  await db.createProviderNode({ id: nodeId, type: "openai-compatible", name: "Release", prefix: "rel", apiType: "chat", baseUrl });
  await db.createProviderConnection({
    provider: nodeId, authType: "apikey", name: "rel-key", apiKey: "sk-test-not-a-real-key-0000", isActive: true, testStatus: "active",
    providerSpecificData: { prefix: "rel", apiType: "chat", baseUrl, nodeName: "Release" },
  });
  ({ POST } = await import("../../src/app/api/v1/messages/route.js"));
  repo = await import("@/lib/db/repos/requestDetailsRepo.js");
}, 120_000);

afterAll(async () => {
  for (const [k, fn] of Object.entries(quiet)) console[k] = fn;
  for (const res of open.splice(0)) res.destroy();
  await new Promise((resolve) => server?.close(resolve));
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

// A ~4 MB Claude Code style prompt, its text in a few large blocks, each
// request's own (`i`), so only the router can keep it.
function promptText(i) {
  const block = (n) => ({ type: "text", text: `${i}:${n} ` + "const value = await stream.read();\n".repeat(30_000) });
  return JSON.stringify({
    model: `rel/${MODEL}`,
    max_tokens: 32000,
    stream: true,
    system: [{ type: "text", text: "You are a coding agent." }],
    messages: [
      { role: "user", content: [block(0), block(1)] },
      { role: "assistant", content: [{ type: "text", text: "Reading." }] },
      { role: "user", content: [block(2), block(3)] },
    ],
  });
}

const request = (text) => new Request("http://localhost/v1/messages", {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": routerKey, "anthropic-version": "2023-06-01", "user-agent": "claude-cli/2.1.0 (external, cli)" },
  body: socketBody(text),
  duplex: "half",
});

// Starts `n` streams and reads each reply's first bytes; returns the heap they
// hold after a full GC while still open, and their readers. The Requests stay
// referenced until the streams end, as Next keeps them.
async function startStreams(n = STREAMS) {
  received.length = 0;
  await settle();
  const before = heap();
  const bodyBytes = promptText(0).length;
  const requests = Array.from({ length: n }, (_, i) => request(promptText(i)));
  const responses = await Promise.all(requests.map((r) => POST(r)));
  expect(responses.map((r) => r.status)).toEqual(Array(n).fill(200));
  const readers = responses.map((r) => r.body.getReader());
  for (const reader of readers) expect((await reader.read()).done).toBe(false);
  await settle();
  expect(received).toHaveLength(n);
  const held = () => (heap() - before) / n;
  return { perStream: held(), held, bodyBytes, readers, requests };
}

async function endStreams(readers) {
  for (const res of open.splice(0)) {
    res.write(chunk({ choices: [{ index: 0, delta: { content: " there" }, finish_reason: null }] }));
    res.write(chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
    res.write(chunk({ choices: [], usage: { prompt_tokens: 500000, completion_tokens: 2, total_tokens: 500002 } }));
    res.end("data: [DONE]\n\n");
  }
  const texts = [];
  for (const reader of readers) {
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    texts.push(text);
  }
  return texts;
}

async function rows() {
  await repo.__test__.flush();
  const { details } = await db.getRequestDetails({ pageSize: 100 });
  return details;
}

describe("a streamed reply holds no copy of its prompt", () => {
  it("lets go of every copy once the reply has started, and still records the request", async () => {
    // A first request warms the route, the DB and the JIT, so they don't count.
    await endStreams((await startStreams(1)).readers);
    await rows();
    const { perStream, bodyBytes, readers, requests } = await startStreams();
    // Each copy of the prompt is about bodyBytes; the old path held about 2.4.
    expect(perStream).toBeLessThan(bodyBytes * 0.25);

    const texts = await endStreams(readers);
    expect(requests).toHaveLength(STREAMS);
    for (const text of texts) expect(text).toContain("there");
    // Sent with its length, not chunked, and whole.
    for (const r of received) {
      expect(r.chunked).toBe(false);
      expect(r.bytes).toBe(r.length);
      expect(r.bytes).toBeGreaterThan(1.5 * MB);
    }
    const saved = (await rows()).slice(0, STREAMS);
    for (const row of saved) {
      expect(row.status).toBe("success");
      expect(row.response.content).toContain("Hi there");
      expect(row.request._truncated).toBe(true);
      expect(row.request._preview).toContain('"messages"');
      expect(row.providerRequest._truncated).toBe(true);
      expect(row.providerRequest._preview).toContain(`"model": "${MODEL}"`);
    }
  }, 120_000);

  // The end row's full copy is built from the bodies (the start row's may be
  // trimmed by then), so they stay; the string sent upstream doesn't.
  it("with full request details on, keeps only the bodies its full copy is built from", async () => {
    await db.updateSettings({ showSensitiveRequestDetails: true });
    await db.clearRequestDetailFullData();
    const { held, bodyBytes, readers } = await startStreams();
    // The 5 s flush writes the start rows, packing their full copies.
    await repo.__test__.flush();
    await settle();
    // The client's body and the translated one: two. The old path also kept
    // the string sent upstream, three in all.
    expect(held()).toBeLessThan(bodyBytes * 2.5);

    await endStreams(readers);
    const saved = (await rows()).slice(0, STREAMS);
    for (const row of saved) {
      expect(row.hasFullData).toBe(true);
      const full = await db.getRequestDetailFullData(row.id);
      expect(full.request.messages).toHaveLength(3);
      expect(full.providerRequest.model).toBe(MODEL);
    }
  }, 120_000);
});
