// OpenAI-compatible upstream for the early-headers E2E. It answers "pong",
// streamed for a stream:true request and as one JSON completion otherwise.
// Behaviour by model id:
//   slow*    - sends no response headers for HOLD_MS, then answers
//   flaky*   - first request per model id: waits FLAKY_MS, then 500; every later
//              one answers (one id per client, so their retries don't mix)
//   hollow*  - a stream with no chunks at once (Claude Code then falls back to
//              a non-streaming request); a non-stream request is held HOLD_MS
//   outage*  - the outage seen in prod: first request per model id hangs
//              OUTAGE_MS, then 500 {"message":""}; later ones answer after OUTAGE_NEXT_MS
//   allfail* - every request waits ALLFAIL_MS, then 500
//   drip<N>  - a stream of N chunks (DRIP_COUNT when no N), DRIP_MS apart,
//              for checking each one reaches the client as it is sent
//   *        - answers at once
// Every request and how it ended is logged as one JSON line.
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT || 9999);
const HOLD_MS = Number(process.env.HOLD_MS || 150_000);
const FLAKY_MS = Number(process.env.FLAKY_MS || 45_000);
const OUTAGE_MS = Number(process.env.OUTAGE_MS || 92_000);
const OUTAGE_NEXT_MS = Number(process.env.OUTAGE_NEXT_MS || 40_000);
const ALLFAIL_MS = Number(process.env.ALLFAIL_MS || 40_000);
const DRIP_MS = Number(process.env.DRIP_MS || 400);
const DRIP_COUNT = Number(process.env.DRIP_COUNT || 5);
const MODELS = ["slow", "flaky", "flaky-codex", "hollow", "outage", "allfail", "fast", "drip"];
const t0 = Date.now();
let seq = 0;
const firstCalls = new Map();

const log = (o) => console.log(JSON.stringify({ t: ((Date.now() - t0) / 1000).toFixed(1), ...o }));
const USAGE = { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 };

// No chunk at all, so the Claude stream never gets a message_start.
function streamHollow(res) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  res.end("data: [DONE]\n\n");
}

function streamReply(res, model) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const chunk = (delta, finish = null) => `data: ${JSON.stringify({
    id: "chatcmpl-mock", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
  res.write(chunk({ role: "assistant", content: "pong" }));
  res.write(chunk({}, "stop"));
  res.write(`data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", model, choices: [], usage: USAGE })}\n\n`);
  res.end("data: [DONE]\n\n");
}

function streamDrip(res, model, count) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const chunk = (delta, finish = null) => `data: ${JSON.stringify({
    id: "chatcmpl-mock", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
  let sent = 0;
  let timer = null;
  const tick = () => {
    if (res.destroyed) return;
    if (sent < count) {
      res.write(chunk(sent === 0 ? { role: "assistant", content: `drip${sent} ` } : { content: `drip${sent} ` }));
      sent++;
      timer = setTimeout(tick, DRIP_MS);
      return;
    }
    res.write(chunk({}, "stop"));
    res.write(`data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", model, choices: [], usage: USAGE })}\n\n`);
    res.end("data: [DONE]\n\n");
  };
  res.on("close", () => clearTimeout(timer));
  tick();
}

function jsonReply(res, model) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    id: "chatcmpl-mock", object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
    usage: USAGE,
  }));
}

function fail500(res, body = { error: { message: "mock upstream failed", type: "server_error" } }) {
  res.writeHead(500, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// Is this the first request for this model id?
function isFirstCall(model) {
  const n = (firstCalls.get(model) || 0) + 1;
  firstCalls.set(model, n);
  return n === 1;
}

http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const id = ++seq;
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: MODELS.map((m) => ({ id: m, object: "model" })) }));
      return;
    }
    let body = {};
    try { body = JSON.parse(raw); } catch { /* not JSON */ }
    const model = String(body.model || "");
    const stream = body.stream === true;
    const started = Date.now();
    log({ id, event: "request", path: req.url, model, stream });
    res.on("close", () => {
      // Not yet ended (a drip stream is answered long before it ends).
      if (!res.writableEnded) log({ id, event: "closed-by-client", model, afterS: ((Date.now() - started) / 1000).toFixed(1) });
    });
    const answer = (fn) => { if (res.destroyed) return; fn(); log({ id, event: "answered", model, stream, afterS: ((Date.now() - started) / 1000).toFixed(1), status: res.statusCode }); };
    const reply = () => (stream ? streamReply(res, model) : jsonReply(res, model));
    const after = (ms, fn) => {
      const t = setTimeout(() => answer(fn), ms);
      res.on("close", () => clearTimeout(t));
    };

    if (model.startsWith("slow")) return after(HOLD_MS, reply);
    if (model.startsWith("hollow")) return stream ? answer(() => streamHollow(res)) : after(HOLD_MS, reply);
    if (model.startsWith("outage")) {
      return isFirstCall(model) ? after(OUTAGE_MS, () => fail500(res, { message: "" })) : after(OUTAGE_NEXT_MS, reply);
    }
    if (model.startsWith("allfail")) return after(ALLFAIL_MS, () => fail500(res));
    if (model.startsWith("drip") && stream) return answer(() => streamDrip(res, model, Number(model.slice(4)) || DRIP_COUNT));
    if (model.startsWith("flaky") && isFirstCall(model)) return after(FLAKY_MS, () => fail500(res));
    answer(reply);
  });
}).listen(PORT, "127.0.0.1", () => log({ event: "listening", port: PORT, holdMs: HOLD_MS }));
