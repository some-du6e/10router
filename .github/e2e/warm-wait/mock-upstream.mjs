// The OpenAI-compatible upstream for the warm-wait E2E, on 127.0.0.1:9998:
// tests/helpers/warmWait.js's warm/cold upstream, driven over HTTP.
// POST /__control takes { limitNext } (the next N warm requests get a 429 at
// once) or { barrier } (hold the next N warm requests, then answer them all
// with a 429). Every /__ request answers with the counters and body digests
// (drive.mjs reads them with an empty POST /__control).
import http from "node:http";
import { warmUpstream } from "../../../tests/helpers/warmWait.js";

const PORT = Number(process.env.MOCK_PORT || 9998);
const { state, handle } = warmUpstream("sk-ww-warm");

const server = http.createServer((req, res) => {
  if (!req.url.startsWith("/__")) {
    handle(req, res);
    return;
  }
  const parts = [];
  req.on("data", (part) => parts.push(part));
  req.on("end", () => {
    if (req.url === "/__control") {
      const msg = JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
      if (typeof msg.limitNext === "number") state.limitNext = msg.limitNext;
      if (typeof msg.barrier === "number") state.arm(msg.barrier);
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ...state, held: state.held.length, bodies: undefined }));
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(`mock upstream on ${PORT}`));
