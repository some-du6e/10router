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
const { finalizeRoutingError } = await import("@/sse/services/finalRoutingError.js");
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
// Per test: null (chatCore answers), a function returning the Response, or
// "hang-up" (the loopback request dies before any reply).
let reply = null;

beforeAll(async () => {
  const compress = compression();
  server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    if (req.method !== "POST") { res.writeHead(404); return res.end(); }
    const body = JSON.parse(raw);
    posted.push({ headers: req.headers, body });
    if (reply === "hang-up") return req.socket.destroy();
    // As router-server.js does, before any route runs.
    compress(req, res, () => {});
    const response = typeof reply === "function" ? reply() : (await handleChatCore({
      body,
      modelInfo: { provider: "openai-compatible-chat-acme", model: MODEL },
      credentials: { apiKey: "key-a", providerSpecificData: { baseUrl: "https://acme.example/v1" } },
      log: { debug() {}, info() {}, warn() {}, error() {} },
      connectionId: "conn-a",
      clientRawRequest: { endpoint: req.url, body, headers: req.headers },
      sourceFormatOverride: "openai-responses",
    })).response;
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
  reply = null;
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
  // Created first, completed last, and for each output item (by output_index):
  // added, then its deltas, then done.
  expect(seen[0]).toBe("response.created");
  expect(seen.indexOf("response.completed")).toBe(seen.length - 1);
  const at = (type, index) => events.map((e, i) => (e.type === type && e.output_index === index ? i : -1)).filter((i) => i >= 0);
  const added = events.filter((e) => e.type === "response.output_item.added");
  expect(added.map((e) => e.item.type).sort()).toEqual(["function_call", "message"]);
  for (const { output_index: index, item } of added) {
    const [open] = at("response.output_item.added", index);
    const done = at("response.output_item.done", index);
    const deltas = [...at("response.output_text.delta", index), ...at("response.function_call_arguments.delta", index)];
    expect(done, `${item.type} item has no output_item.done`).toHaveLength(1);
    expect(deltas.length, `${item.type} item has no deltas`).toBeGreaterThan(0);
    for (const d of deltas) {
      expect(d).toBeGreaterThan(open);
      expect(d).toBeLessThan(done[0]);
    }
  }
  const text = events.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join("");
  expect(text).toBe("ok");
  const args = events.filter((e) => e.type === "response.function_call_arguments.delta").map((e) => e.delta).join("");
  expect(JSON.parse(args)).toEqual({ cmd: "ls" });
  const completed = events.find((e) => e.type === "response.completed");
  expect(completed.response.usage).toMatchObject({ input_tokens: USAGE.prompt_tokens, output_tokens: USAGE.completion_tokens });
}

// Each `until` gives up after 3s and a test chains at most two, so this lets a
// slow runner report the failed assertion instead of a test timeout.
describe("Codex WebSocket turn on a translated endpoint", { timeout: 15_000 }, () => {
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

  it("hands Codex the gateway's plain-text limit refusal word for word, as a 400", async () => {
    // What a bridged Codex turn gets when every account is out of limits.
    const resetAtMs = Date.now() + 90 * 60 * 1000;
    reply = () => finalizeRoutingError(new Response("{}", { status: 429 }), { clientTool: "codex", routingFailures: [{ limited: true, resetAtMs }] });
    const expected = await reply().text();
    expect(expected).toMatch(/^All your accounts have hit their limits\. Next account resets in /);
    const ws = await connect(VIA_PROXY);
    ws.send(TURN);
    const events = await ws.until((e) => e.some((x) => "close" in x));
    ws.close();
    expect(events[0]).toEqual({ type: "error", status: 400, error: { message: expected, type: "invalid_request_error" } });
    expect(events.at(-1)).toMatchObject({ close: 1011 });
  });

  it("caps a plain-text error at 2000 characters without splitting one", () => {
    const frame = (raw) => JSON.parse(__test__.bridgeErrorFrame(raw, 400)).error.message;
    expect(frame("x".repeat(5000))).toBe("x".repeat(2000));
    // The cap lands between the two halves of an emoji's surrogate pair.
    const message = frame(`${"a".repeat(1999)}😀😀`);
    expect(message).toBe(`${"a".repeat(1999)}😀`);
    expect(message).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it("cuts a huge error body before spreading it, and relays only its head", async () => {
    const huge = `${"e".repeat(3000)}${"z".repeat(8 * 1024 * 1024)}`;
    const spread = vi.spyOn(Array, "from");
    try {
      expect(JSON.parse(__test__.bridgeErrorFrame(huge, 500)).error.message).toBe("e".repeat(2000));
      expect(spread).toHaveBeenCalled();
      for (const [arg] of spread.mock.calls) expect(arg?.length ?? 0).toBeLessThanOrEqual(4000);
      // A JSON error object is used as is, without building the text at all.
      spread.mockClear();
      __test__.bridgeErrorFrame(JSON.stringify({ error: { message: "m", type: "t" }, pad: huge }), 400);
      expect(spread).not.toHaveBeenCalled();
    } finally {
      spread.mockRestore();
    }
    // Through the bridge: an 8 MB plain-text 502 still ends as one capped frame.
    reply = () => new Response(huge, { status: 502, headers: { "content-type": "text/plain" } });
    const ws = await connect(VIA_PROXY);
    ws.send(TURN);
    const events = await ws.until((e) => e.some((x) => "close" in x));
    ws.close();
    expect(events[0]).toEqual({ type: "error", status: 502, error: { message: "e".repeat(2000), type: "server_error" } });
  });

  it("keeps at most the cap plus one chunk of an error body", async () => {
    const cap = __test__.MAX_ERROR_BODY;
    reply = () => new Response("q".repeat(8 * cap), { status: 400, headers: { "content-type": "text/plain" } });
    const kept = await new Promise((resolve) => {
      let length = 0;
      __test__.bridgeCodexTurn(TURN, port, VIA_PROXY, "127.0.0.1", () => {}, () => resolve(length), {
        errorFrame: (raw, status) => { length = raw.length; return __test__.bridgeErrorFrame(raw, status); },
      });
    });
    expect(kept).toBeGreaterThanOrEqual(cap);
    // One HTTP chunk past the cap at most (Node reads in 64 KB pieces).
    expect(kept).toBeLessThanOrEqual(cap + 64 * 1024);
  });

  it("keeps a large JSON error envelope structured", async () => {
    const message = `rejected: ${"x".repeat(200 * 1024)}`;
    reply = () => new Response(JSON.stringify({ error: { message, type: "invalid_request_error", code: "invalid_value" } }), { status: 422, headers: { "content-type": "application/json" } });
    const ws = await connect(VIA_PROXY);
    ws.send(TURN);
    const events = await ws.until((e) => e.some((x) => "close" in x));
    ws.close();
    expect(events[0]).toEqual({ type: "error", status: 422, error: { message, type: "invalid_request_error", code: "invalid_value" } });
  });

  it("reports a loopback request that died as a 502, which Codex retries", async () => {
    reply = "hang-up";
    const ws = await connect(VIA_PROXY);
    ws.send(TURN);
    const events = await ws.until((e) => e.some((x) => "close" in x));
    ws.close();
    expect(events[0]).toMatchObject({ type: "error", status: 502, error: { type: "server_error" } });
    expect(events.at(-1)).toMatchObject({ close: 1011, reason: "bridge error" });
  });

  it("refuses an overlapping turn with a 409 and still finishes the first", async () => {
    fetchMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 300));
      return new Response(upstreamStream(), { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const ws = await connect(VIA_PROXY);
    ws.send(TURN);
    ws.send(TURN);
    const events = await ws.until((e) => completedCount(e) === 1);
    ws.close();
    expect(events[0]).toEqual({
      type: "error", status: 409,
      error: { message: "A turn is already in progress on this connection", type: "invalid_request_error", code: "turn_in_progress" },
    });
    expect(posted).toHaveLength(1);
    expectFullTurn(events.slice(1));
  });

  it("hands an upstream rejection to Codex as the HTTP error it is, then closes", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: { message: "tool schema rejected", type: "invalid_request_error" } }), { status: 400, headers: { "content-type": "application/json" } }));
    const ws = await connect(VIA_PROXY);
    ws.send(TURN);
    const events = await ws.until((e) => e.some((x) => "close" in x));
    ws.close();
    // Codex 0.137 maps an error frame to an HTTP error only when it has a status.
    expect(events[0]).toMatchObject({ type: "error", status: 400 });
    expect(events[0].error.message).toContain("tool schema rejected");
    expect(events.at(-1)).toMatchObject({ close: 1011 });
  });

  it("still declines a delta turn with previous_response_not_found and closes", async () => {
    const ws = await connect(VIA_PROXY);
    ws.send({ ...TURN, previous_response_id: "resp_earlier" });
    const events = await ws.until((e) => e.some((x) => "close" in x));
    ws.close();
    expect(posted).toHaveLength(0);
    expect(events[0]).toMatchObject({ type: "error", error: { code: "previous_response_not_found", param: "previous_response_id" } });
    // No status: with one, Codex would take a 400 as final instead of retrying
    // the turn in full on a new connection.
    expect(events[0].status).toBeUndefined();
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
    expect(events[0].status).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ close: 1000 });
  });
});
