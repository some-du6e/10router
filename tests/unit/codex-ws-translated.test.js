// Codex's WebSocket transport on a model served by a translated (Chat
// Completions) endpoint. A real WebSocket client drives the bridge in
// custom-server.js against a loopback server that answers the way the app
// does: chatCore translating a mocked Chat Completions upstream stream into the
// Responses stream, written through Next's own compression middleware.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
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
// Loading it wraps http.createServer, which is what adds the bridge.
const { __test__ } = require("../../custom-server.js");
// The middleware Next's router server puts in front of every response.
const compression = require("next/dist/compiled/compression");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { initTranslators } = await import("../../open-sse/translator/index.js");
await initTranslators();

const MODEL = "claude-opus-5-5";
const USAGE = { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 };
const chatChunk = (delta, finish = null, extra = {}) =>
  `data: ${JSON.stringify({ id: "chatcmpl-a", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;

// What the custom endpoint streams: a little text, then one tool call whose
// arguments arrive in two pieces, then usage.
function upstreamStream() {
  const parts = [
    chatChunk({ role: "assistant", content: "" }),
    chatChunk({ content: "ok" }),
    chatChunk({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "shell", arguments: "" } }] }),
    chatChunk({ tool_calls: [{ index: 0, function: { arguments: "{\"cmd\":" } }] }),
    chatChunk({ tool_calls: [{ index: 0, function: { arguments: "\"ls\"}" } }] }),
    chatChunk({}, "tool_calls"),
    `data: ${JSON.stringify({ id: "chatcmpl-a", object: "chat.completion.chunk", model: MODEL, choices: [], usage: USAGE })}\n\n`,
    "data: [DONE]\n\n",
  ];
  const encoder = new TextEncoder();
  return new ReadableStream({ start(c) { for (const p of parts) c.enqueue(encoder.encode(p)); c.close(); } });
}

const TURN = {
  type: "response.create",
  model: `acme/${MODEL}`,
  instructions: "be brief",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "reply with just: ok" }] }],
  tools: [{ type: "function", name: "shell", description: "run a command", parameters: { type: "object", properties: { cmd: { type: "string" } } } }],
  tool_choice: "auto",
  parallel_tool_calls: false,
  store: false,
  stream: true,
  include: [],
};

// The handshake Codex sends, as it reaches the origin through a proxy that
// asks for compressed replies (Cloudflare adds `accept-encoding: gzip`).
const CODEX_HEADERS = {
  "user-agent": "codex_exec/0.137.0 (Ubuntu 24.4.0; x86_64) unknown (codex_exec; 0.137.0)",
  originator: "codex_exec",
  authorization: "Bearer key-a",
  "openai-beta": "responses_websockets=2026-02-06",
  "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn" }),
};
const VIA_PROXY = { ...CODEX_HEADERS, "accept-encoding": "gzip, br" };

let server;
let port;
const sockets = new Set();
const posted = [];

beforeAll(async () => {
  const compress = compression();
  server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    if (req.method !== "POST") { res.writeHead(404); return res.end(); }
    const body = JSON.parse(raw);
    posted.push({ headers: req.headers, body });
    // As router-server.js does, before any route runs.
    compress(req, res, () => {});
    const { response } = await handleChatCore({
      body,
      modelInfo: { provider: "openai-compatible-chat-acme", model: MODEL },
      credentials: { apiKey: "key-a", providerSpecificData: { baseUrl: "https://acme.example/v1" } },
      log: { debug() {}, info() {}, warn() {}, error() {} },
      connectionId: "conn-a",
      clientRawRequest: { endpoint: req.url, body, headers: req.headers },
      sourceFormatOverride: "openai-responses",
    });
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.flushHeaders();
    const reader = response.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
      res.flush?.(); // Next flushes after every chunk so compressed streams still stream
    }
    res.end();
  });
  // Next's server always listens for upgrades; without a listener Node hands
  // the handshake to the request handler instead.
  server.on("upgrade", (_req, socket) => socket.destroy());
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise((r) => server.close(r));
});

beforeEach(() => {
  posted.length = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(upstreamStream(), { status: 200, headers: { "content-type": "text/event-stream" } }));
});

function maskedText(text) {
  const payload = Buffer.from(text);
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  }
  for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  return Buffer.concat([header, mask, payload]);
}

/**
 * Open a WebSocket to the bridge and return a client that sends text frames
 * and collects what comes back: parsed events, and `{ close: code }`.
 */
function connect(headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, path: "/backend-api/codex/responses",
      headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": crypto.randomBytes(16).toString("base64"), ...headers },
    });
    req.on("error", reject);
    req.on("response", (res) => reject(new Error(`no upgrade: HTTP ${res.statusCode}`)));
    req.on("upgrade", (_res, socket) => {
      const events = [];
      const waiters = [];
      let buf = Buffer.alloc(0);
      const settle = () => { for (const w of [...waiters]) w(); };
      socket.on("data", (d) => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          if (buf.length < 2) break;
          let len = buf[1] & 0x7f;
          let off = 2;
          if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (buf.length < off + len) break;
          const opcode = buf[0] & 0x0f;
          const payload = buf.subarray(off, off + len);
          buf = buf.subarray(off + len);
          if (opcode === 0x8) events.push({ close: payload.length >= 2 ? payload.readUInt16BE(0) : null, reason: payload.subarray(2).toString() });
          if (opcode === 0x1) events.push(JSON.parse(payload.toString()));
        }
        settle();
      });
      resolve({
        events,
        send: (frame) => socket.write(maskedText(JSON.stringify(frame))),
        // Resolves once `done(events)` holds, or after `ms` regardless.
        until: (done, ms = 3000) => new Promise((r) => {
          const check = () => { if (done(events)) { finish(); } };
          const finish = () => { clearTimeout(timer); waiters.splice(waiters.indexOf(check), 1); r(events); };
          const timer = setTimeout(finish, ms);
          waiters.push(check);
          check();
        }),
        close: () => socket.destroy(),
      });
    });
    req.end();
  });
}

const types = (events) => events.map((e) => e.type || `close:${e.close}`);
const completedCount = (events) => events.filter((e) => e.type === "response.completed").length;

function expectFullTurn(events) {
  const seen = types(events);
  for (const type of [
    "response.created",
    "response.output_item.added",
    "response.output_text.delta",
    "response.function_call_arguments.delta",
    "response.output_item.done",
    "response.completed",
  ]) expect(seen, `missing ${type}`).toContain(type);
  expect(seen.indexOf("response.created")).toBe(0);
  const text = events.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join("");
  expect(text).toBe("ok");
  const args = events.filter((e) => e.type === "response.function_call_arguments.delta").map((e) => e.delta).join("");
  expect(JSON.parse(args)).toEqual({ cmd: "ls" });
  const completed = events.find((e) => e.type === "response.completed");
  expect(completed.response.usage).toMatchObject({ input_tokens: USAGE.prompt_tokens, output_tokens: USAGE.completion_tokens });
}

describe("Codex WebSocket turn on a translated endpoint", () => {
  it("streams the whole turn when the handshake came through a proxy that asks for gzip", async () => {
    const ws = await connect(VIA_PROXY);
    ws.send(TURN);
    const events = await ws.until((e) => completedCount(e) === 1);
    ws.close();
    expect(posted).toHaveLength(1);
    expectFullTurn(events);
  });

  it("asks the loopback POST for a plain event stream whatever the handshake accepted", () => {
    const forwarded = __test__.bridgeForwardHeaders({ ...VIA_PROXY, accept: "*/*" }, "127.0.0.1", 10);
    expect(forwarded["accept-encoding"]).toBe("identity");
    expect(forwarded.accept).toBe("text/event-stream");
    expect(forwarded["user-agent"]).toBe(VIA_PROXY["user-agent"]);
  });

  it("serves sequential response.create frames on one socket", async () => {
    const ws = await connect(VIA_PROXY);
    ws.send(TURN);
    await ws.until((e) => completedCount(e) === 1);
    const first = ws.events.length;
    ws.send({ ...TURN, input: [...TURN.input, { type: "message", role: "user", content: [{ type: "input_text", text: "again" }] }] });
    const events = await ws.until((e) => completedCount(e) === 2);
    ws.close();
    expect(posted).toHaveLength(2);
    expectFullTurn(events.slice(first));
  });

  it("still declines a delta turn with previous_response_not_found and closes", async () => {
    const ws = await connect(VIA_PROXY);
    ws.send({ ...TURN, previous_response_id: "resp_earlier" });
    const events = await ws.until((e) => e.some((x) => "close" in x));
    ws.close();
    expect(posted).toHaveLength(0);
    expect(events[0]).toMatchObject({ type: "error", error: { code: "previous_response_not_found", param: "previous_response_id" } });
    expect(events.at(-1)).toMatchObject({ close: 1000 });
  });

  it("still declines the startup prewarm without running a generation", async () => {
    const ws = await connect({ ...VIA_PROXY, "x-codex-turn-metadata": JSON.stringify({ request_kind: "prewarm" }) });
    ws.send({ ...TURN, generate: false });
    const events = await ws.until((e) => e.some((x) => "close" in x));
    ws.close();
    expect(posted).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({ type: "error", error: { code: "prewarm_unsupported" } });
    expect(events.at(-1)).toMatchObject({ close: 1000 });
  });
});
