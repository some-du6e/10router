// A tiny OpenAI-compatible Chat Completions upstream for the Codex WebSocket
// E2E. Every POST streams the fixed reply "ok" (or answers it as one JSON
// completion when the request does not stream); GET /models lists one model.
// Each request is logged as one JSON line, with its path, model and whether it
// streamed, never its headers.
import http from "node:http";

const PORT = Number(process.env.STUB_PORT || 9998);
const MODEL = process.env.STUB_MODEL || "claude-opus-5-5";
const USAGE = { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 };
const log = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));

const chunk = (model, delta, finish = null) => `data: ${JSON.stringify({
  id: "chatcmpl-stub", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model,
  choices: [{ index: 0, delta, finish_reason: finish }],
})}\n\n`;

http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: MODEL, object: "model" }] }));
      return;
    }
    let body = {};
    try { body = JSON.parse(raw); } catch { /* not JSON */ }
    const model = String(body.model || MODEL);
    log({ event: "request", path: req.url, model, stream: body.stream === true, tools: Array.isArray(body.tools) ? body.tools.length : 0 });
    if (body.stream === true) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write(chunk(model, { role: "assistant", content: "ok" }));
      res.write(chunk(model, {}, "stop"));
      res.write(`data: ${JSON.stringify({ id: "chatcmpl-stub", object: "chat.completion.chunk", model, choices: [], usage: USAGE })}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-stub", object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: USAGE,
    }));
  });
}).listen(PORT, "127.0.0.1", () => log({ event: "listening", port: PORT }));
