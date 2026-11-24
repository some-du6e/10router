// The OpenAI-compatible upstream for the warm-wait E2E, on 127.0.0.1:9998.
// Requests on the warm key ("sk-ww-warm…") are answered according to the
// control state; the cold key is always served (and counted: the E2E expects
// none). POST /__control takes { limitNext } (the next N warm requests get a
// 429 at once) or { barrier } (hold the next N warm requests, then answer them
// all with a 429; warm requests after those are counted as resumed). GET
// /__state returns the counters and the SHA-256 of each limited and resumed
// body.
import crypto from "node:crypto";
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT || 9998);
const MODEL = "kimi-k3";
const base = { id: "chatcmpl-ww", object: "chat.completion.chunk", created: 1700000000, model: MODEL };
const chunk = (obj) => `data: ${JSON.stringify({ ...base, ...obj })}\n\n`;

const state = { limitNext: 0, barrier: 0, held: [], limited: [], resumed: [], cold: 0, warm: 0 };

function reply(res) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.write(chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hi" }, finish_reason: null }] }));
  res.write(chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
  res.write(chunk({ choices: [], usage: { prompt_tokens: 250000, completion_tokens: 1, total_tokens: 250001 } }));
  res.end("data: [DONE]\n\n");
}

function limit(res) {
  res.writeHead(429, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Too many requests", type: "requests", code: "429" } }));
}

const server = http.createServer((req, res) => {
  const hash = crypto.createHash("sha256");
  const parts = [];
  const control = req.url.startsWith("/__");
  req.on("data", (part) => (control ? parts.push(part) : hash.update(part)));
  req.on("end", () => {
    if (req.url === "/__state") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...state, held: state.held.length }));
      return;
    }
    if (req.url === "/__control") {
      const msg = JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
      if (typeof msg.limitNext === "number") state.limitNext = msg.limitNext;
      if (typeof msg.barrier === "number") Object.assign(state, { barrier: msg.barrier, limited: [], resumed: [], cold: 0 });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    const digest = hash.digest("hex");
    if (!(req.headers.authorization || "").includes("sk-ww-warm")) {
      state.cold++;
      reply(res);
      return;
    }
    state.warm++;
    if (state.limitNext > 0) {
      state.limitNext--;
      limit(res);
      return;
    }
    if (state.barrier > 0) {
      state.held.push(res);
      state.limited.push(digest);
      if (state.held.length < state.barrier) return;
      state.barrier = 0;
      for (const held of state.held.splice(0)) limit(held);
      return;
    }
    if (state.limited.length) state.resumed.push(digest);
    reply(res);
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(`mock upstream on ${PORT}`));
