// Scratch harness (iterating): drive the Codex WebSocket bridge against a
// loopback server that serves the real translated Responses stream.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import http from "node:http";
import crypto from "node:crypto";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...a) => fetchMock(...a) }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn(), logOpenAIRequest: vi.fn(),
  }),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}), saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}),
}));

const require = createRequire(import.meta.url);
require("../../custom-server.js");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { initTranslators } = await import("../../open-sse/translator/index.js");
await initTranslators?.();

const chunk = (delta, extra = {}) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: "claude-opus-5-5", choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;
function chatStream() {
  const parts = [
    chunk({ role: "assistant", content: "" }),
    chunk({ content: "ok" }),
    `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } })}\n\n`,
    "data: [DONE]\n\n",
  ];
  const enc = new TextEncoder();
  return new ReadableStream({ start(c) { for (const p of parts) c.enqueue(enc.encode(p)); c.close(); } });
}

let server;
let port;
const seen = [];
beforeAll(async () => {
  fetchMock.mockImplementation(async () => new Response(chatStream(), { status: 200, headers: { "content-type": "text/event-stream" } }));
  server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    console.log("HANDLER", req.method, req.url, JSON.stringify(req.headers), raw.length);
    const body = JSON.parse(raw);
    seen.push({ headers: req.headers, body });
    const result = await handleChatCore({
      body,
      modelInfo: { provider: "openai-compatible-chat-acme", model: "claude-opus-5-5" },
      credentials: { apiKey: "key-a", providerSpecificData: { baseUrl: "https://acme.example/v1" } },
      log: { debug() {}, info() {}, warn() {}, error() {} },
      connectionId: "conn-a",
      clientRawRequest: { endpoint: "/backend-api/codex/responses", body, headers: req.headers },
      sourceFormatOverride: "openai-responses",
    });
    const response = result.response;
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    if (!response.body) return res.end();
    const reader = response.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  });
  server.on("upgrade", (_req, socket) => socket.destroy());
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});
afterAll(() => { server.closeAllConnections(); return new Promise((r) => server.close(r)); });

function maskedText(text) {
  const payload = Buffer.from(text);
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
  else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
  const out = Buffer.from(payload);
  for (let i = 0; i < out.length; i++) out[i] ^= mask[i & 3];
  return Buffer.concat([header, mask, out]);
}

function wsTurn(frames, headers = {}, { untilType = "response.completed", timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/backend-api/codex/responses", headers: {
      connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": crypto.randomBytes(16).toString("base64"), ...headers,
    } });
    req.on("error", reject);
    req.on("upgrade", (res, socket) => {
      const events = [];
      let buf = Buffer.alloc(0);
      const timer = setTimeout(() => { socket.destroy(); resolve({ events, timedOut: true }); }, timeoutMs);
      socket.on("data", (d) => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          if (buf.length < 2) return;
          let len = buf[1] & 0x7f; let off = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (buf.length < off + len) return;
          const op = buf[0] & 0x0f; const payload = buf.subarray(off, off + len); buf = buf.subarray(off + len);
          if (op === 0x8) { events.push({ close: payload.length >= 2 ? payload.readUInt16BE(0) : null }); clearTimeout(timer); socket.destroy(); return resolve({ events }); }
          if (op === 0x1) {
            const ev = JSON.parse(payload.toString());
            events.push(ev);
            if (ev.type === untilType) { clearTimeout(timer); socket.destroy(); return resolve({ events }); }
          }
        }
      });
      for (const f of frames) socket.write(maskedText(JSON.stringify(f)));
    });
    req.end();
  });
}

describe("scratch", () => {
  it("bridges a translated turn", async () => {
    const out = await wsTurn([{ type: "response.create", model: "acme/claude-opus-5-5", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }], tools: [], tool_choice: "auto", parallel_tool_calls: false, store: false, stream: true, include: [] }],
      { "user-agent": "codex_cli_rs/0.137.0", originator: "codex_exec", authorization: "Bearer key-a", "openai-beta": "responses_websockets=2026-02-06", "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn" }) });
    (await import("node:fs")).writeFileSync("/tmp/codexws-out.json", JSON.stringify(out, null, 1));
    expect(out.timedOut).toBeFalsy();
  });

  it.runIf(!!process.env.SCRATCH_CODEX_BIN)("real codex", async () => {
    const fs = await import("node:fs");
    const { spawn } = await import("node:child_process");
    const home = fs.mkdtempSync("/tmp/codexhome-");
    fs.writeFileSync(`${home}/config.toml`, `openai_base_url = "http://127.0.0.1:${port}/backend-api/codex"\nmodel = "acme/claude-opus-5-5"\n`);
    const out = await new Promise((resolve) => {
      const child = spawn(process.env.SCRATCH_CODEX_BIN, ["exec", "--skip-git-repo-check", "-m", "acme/claude-opus-5-5", "reply with just: ok"], {
        env: { ...process.env, CODEX_HOME: home, CODEX_API_KEY: "key-a", RUST_LOG: "codex_api=trace,codex_core::client=trace" }, cwd: home,
      });
      let text = "";
      child.stdout.on("data", (d) => { text += d; });
      child.stderr.on("data", (d) => { text += d; });
      const t = setTimeout(() => { child.kill("SIGKILL"); }, 40000);
      child.on("close", (code) => { clearTimeout(t); resolve({ code, text }); });
    });
    fs.writeFileSync("/tmp/codexws-real.txt", `${out.code}\n${out.text}\n\nSEEN:\n${JSON.stringify(seen.map((s) => ({ h: s.headers, b: { ...s.body, tools: s.body.tools?.length, instructions: s.body.instructions?.length, input: s.body.input?.length } })), null, 1)}`);
  }, 60000);
});
