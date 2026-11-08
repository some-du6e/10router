// Mock upstream for the key budgets E2E: an Anthropic Messages API
// (POST /v1/messages) and an OpenAI Responses API (POST /v1/responses) on one
// port. Both stream realistic events with usage, so 10router can price them.
//   - a prompt containing "E2E_SLOW_STREAM" gets a long, slow Anthropic stream
//     (many content deltas, message_delta only at the end) for the abort test
//   - GET /__stats returns how many model requests arrived, per path and model
// Every request is logged as one JSON line.
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT || 9999);
const USAGE_IN = Number(process.env.MOCK_INPUT_TOKENS || 2000);
const USAGE_OUT = Number(process.env.MOCK_OUTPUT_TOKENS || 300);
const SLOW_IN = 1000;
const SLOW_DELTAS = 60;
const SLOW_GAP_MS = 250;
const t0 = Date.now();
let seq = 0;
const stats = { total: 0, byPath: {}, byModel: {} };
const log = (o) => console.log(JSON.stringify({ t: ((Date.now() - t0) / 1000).toFixed(1), ...o }));
const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

function anthropicStream(res, model, slow) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const id = `msg_mock_${seq}`;
  const inTok = slow ? SLOW_IN : USAGE_IN;
  sse(res, "message_start", { type: "message_start", message: {
    id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: inTok, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  } });
  sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  sse(res, "ping", { type: "ping" });
  const finish = (outTok) => {
    sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
    sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: outTok } });
    sse(res, "message_stop", { type: "message_stop" });
    res.end();
  };
  if (!slow) {
    for (const piece of ["Hi", " there", "!"]) sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } });
    return finish(USAGE_OUT);
  }
  // ~100 tokens of text per delta.
  const text = "The quick brown fox jumps over the lazy dog while counting tokens. ".repeat(6);
  let i = 0;
  const timer = setInterval(() => {
    if (res.destroyed) return clearInterval(timer);
    sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
    if (++i >= SLOW_DELTAS) { clearInterval(timer); finish(SLOW_DELTAS * 100); }
  }, SLOW_GAP_MS);
  res.on("close", () => clearInterval(timer));
}

function anthropicJson(res, model) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    id: `msg_mock_${seq}`, type: "message", role: "assistant", model,
    content: [{ type: "text", text: "Hi there!" }], stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: USAGE_IN, output_tokens: USAGE_OUT },
  }));
}

function responsesStream(res, model) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const id = `resp_mock_${seq}`;
  const msgId = `msg_mock_${seq}`;
  const created_at = Math.floor(Date.now() / 1000);
  const base = { id, object: "response", created_at, model, status: "in_progress", output: [] };
  let n = 0;
  const ev = (type, data) => sse(res, type, { type, sequence_number: n++, ...data });
  ev("response.created", { response: base });
  ev("response.in_progress", { response: base });
  ev("response.output_item.added", { output_index: 0, item: { id: msgId, type: "message", status: "in_progress", role: "assistant", content: [] } });
  ev("response.content_part.added", { item_id: msgId, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
  for (const delta of ["Hi", " there", "!"]) ev("response.output_text.delta", { item_id: msgId, output_index: 0, content_index: 0, delta });
  const text = "Hi there!";
  ev("response.output_text.done", { item_id: msgId, output_index: 0, content_index: 0, text });
  const part = { type: "output_text", text, annotations: [] };
  ev("response.content_part.done", { item_id: msgId, output_index: 0, content_index: 0, part });
  const item = { id: msgId, type: "message", status: "completed", role: "assistant", content: [part] };
  ev("response.output_item.done", { output_index: 0, item });
  ev("response.completed", { response: { ...base, status: "completed", output: [item], usage: {
    input_tokens: USAGE_IN * 4, input_tokens_details: { cached_tokens: 0 },
    output_tokens: USAGE_OUT * 3, output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: USAGE_IN * 4 + USAGE_OUT * 3,
  } } });
  res.end();
}

http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    if (req.method === "GET" && req.url === "/__stats") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(stats));
    }
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ object: "list", data: [] }));
    }
    const id = ++seq;
    let body = {};
    try { body = JSON.parse(raw); } catch { /* not JSON */ }
    const model = String(body.model || "");
    const stream = body.stream === true;
    const path = req.url.split("?")[0];
    stats.total++;
    stats.byPath[path] = (stats.byPath[path] || 0) + 1;
    stats.byModel[model] = (stats.byModel[model] || 0) + 1;
    const slow = raw.includes("E2E_SLOW_STREAM");
    log({ id, event: "request", path, model, stream, slow });
    res.on("close", () => log({ id, event: res.writableFinished ? "answered" : "closed-by-client", model }));
    if (path.endsWith("/messages")) return stream ? anthropicStream(res, model, slow) : anthropicJson(res, model);
    if (path.endsWith("/responses")) return responsesStream(res, model);
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `mock: no route for ${path}` } }));
  });
}).listen(PORT, "127.0.0.1", () => log({ event: "listening", port: PORT }));
