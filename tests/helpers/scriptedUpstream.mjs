// An OpenAI-compatible chat upstream in its own process, so what it allocates
// is not counted with the router's. The parent sends `{ fail: K }` over IPC
// before a request: the next K chat requests get a 429, the one after a short
// SSE reply with usage. It reports `{ port }` once listening and `{ served }`
// (the body bytes of each request it read) after every request.
import http from "node:http";

const MODEL = process.env.UPSTREAM_MODEL || "bench-model";
const base = { id: "chatcmpl-bench", object: "chat.completion.chunk", created: 1700000000, model: MODEL };
const chunk = (obj) => `data: ${JSON.stringify({ ...base, ...obj })}\n\n`;

let failNext = 0;
process.on("message", (msg) => {
  if (msg && typeof msg.fail === "number") {
    failNext = msg.fail;
    process.send({ ack: true });
  }
});

const server = http.createServer((req, res) => {
  let bytes = 0;
  req.on("data", (part) => { bytes += part.length; });
  req.on("end", () => {
    process.send({ served: bytes, status: failNext > 0 ? 429 : 200 });
    if (failNext > 0) {
      failNext--;
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Rate limit reached for requests", type: "rate_limit_error", code: "rate_limit_exceeded" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hi" }, finish_reason: null }] }));
    res.write(chunk({ choices: [{ index: 0, delta: { content: " there" }, finish_reason: null }] }));
    res.write(chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
    res.write(chunk({ choices: [], usage: { prompt_tokens: 250000, completion_tokens: 2, total_tokens: 250002 } }));
    res.end("data: [DONE]\n\n");
  });
});

server.listen(0, "127.0.0.1", () => process.send({ port: server.address().port }));
process.on("disconnect", () => process.exit(0));
