// OpenAI-compatible upstream for the early-headers E2E. Behaviour by model id:
//   slow*  - sends no response headers for HOLD_MS, then streams "pong"
//   flaky* - first request per model id: waits FLAKY_MS, then 500; every later
//            one streams "pong" (one id per client, so their retries don't mix)
//   *      - streams "pong" at once
// Every request and how it ended is logged as one JSON line.
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT || 9999);
const HOLD_MS = Number(process.env.HOLD_MS || 150_000);
const FLAKY_MS = Number(process.env.FLAKY_MS || 45_000);
const t0 = Date.now();
let seq = 0;
const flakyCalls = new Map();

const log = (o) => console.log(JSON.stringify({ t: ((Date.now() - t0) / 1000).toFixed(1), ...o }));

function streamPong(res, model) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const chunk = (delta, finish = null) => `data: ${JSON.stringify({
    id: "chatcmpl-mock", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
  res.write(chunk({ role: "assistant", content: "pong" }));
  res.write(chunk({}, "stop"));
  res.write(`data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", model, choices: [], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } })}\n\n`);
  res.end("data: [DONE]\n\n");
}

http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const id = ++seq;
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: ["slow", "flaky", "flaky-codex", "fast"].map((m) => ({ id: m, object: "model" })) }));
      return;
    }
    let body = {};
    try { body = JSON.parse(raw); } catch { /* not JSON */ }
    const model = String(body.model || "");
    const started = Date.now();
    let finished = false;
    log({ id, event: "request", path: req.url, model, stream: body.stream === true });
    res.on("close", () => {
      if (!finished) log({ id, event: "closed-by-client", model, afterS: ((Date.now() - started) / 1000).toFixed(1) });
    });
    const answer = (fn) => { if (res.destroyed) return; finished = true; fn(); log({ id, event: "answered", model, afterS: ((Date.now() - started) / 1000).toFixed(1), status: res.statusCode }); };

    if (model.startsWith("slow")) {
      const t = setTimeout(() => answer(() => streamPong(res, model)), HOLD_MS);
      res.on("close", () => clearTimeout(t));
      return;
    }
    const flakyCall = model.startsWith("flaky") ? (flakyCalls.get(model) || 0) + 1 : 0;
    if (flakyCall) flakyCalls.set(model, flakyCall);
    if (flakyCall === 1) {
      const t = setTimeout(() => answer(() => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "mock upstream failed", type: "server_error" } }));
      }), FLAKY_MS);
      res.on("close", () => clearTimeout(t));
      return;
    }
    answer(() => streamPong(res, model));
  });
}).listen(PORT, "127.0.0.1", () => log({ event: "listening", port: PORT, holdMs: HOLD_MS }));
