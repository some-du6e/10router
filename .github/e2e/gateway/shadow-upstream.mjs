// Anthropic Messages upstream for the shadow E2E (shadow.sh): every
// POST .../messages answers "pong", as SSE when the body asks for a stream
// and as one message otherwise. Each request is logged as one JSON line.
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT || 9998);
let seq = 0;

const usage = { input_tokens: 5, output_tokens: 1 };
const message = (model) => ({ id: `msg_mock${++seq}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage });

function stream(res, model) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event("message_start", { message: message(model) });
  event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "pong" } });
  event("content_block_stop", { index: 0 });
  event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
  event("message_stop", {});
  res.end();
}

http.createServer((req, res) => {
  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body = {};
    try { body = JSON.parse(raw); } catch {}
    console.log(JSON.stringify({ method: req.method, url: req.url, model: body.model, stream: body.stream === true, bytes: raw.length }));
    if (req.method !== "POST" || !req.url.endsWith("/messages")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "not found" } }));
      return;
    }
    if (body.stream === true) return stream(res, body.model);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ...message(body.model), content: [{ type: "text", text: "pong" }], stop_reason: "end_turn" }));
  });
}).listen(PORT, "127.0.0.1", () => console.log(JSON.stringify({ listening: PORT })));
