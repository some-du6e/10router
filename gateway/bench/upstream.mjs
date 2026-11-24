// A stand-in app server for the proxy-overhead benchmark (gateway-bench). It
// is plain Node http, like the real one, so "direct" vs "through the gateway"
// compares the same Node work with and without the Go hop in front.
//   POST /small  1 KB JSON in, small JSON out
//   POST /sse    a request body in, EVENTS server-sent events out, each written
//                on its own as the real stream writes them
//   POST /big    a multi-megabyte body in, small JSON out
// Listens on HOSTNAME:PORT, the way the gateway starts the real app server.
import http from "node:http";

const PORT = Number(process.env.PORT || 18081);
const HOST = process.env.HOSTNAME || "127.0.0.1";
const EVENTS = Number(process.env.EVENTS || 50);
const EVENT = `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x".repeat(200) } })}\n\n`;

const server = http.createServer((req, res) => {
  let bytes = 0;
  req.on("data", (chunk) => { bytes += chunk.length; });
  req.on("end", () => {
    if (req.url === "/sse") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      for (let i = 0; i < EVENTS; i++) res.write(EVENT);
      res.end("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
      return;
    }
    const body = JSON.stringify({ ok: true, bytes });
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
  });
});
server.keepAliveTimeout = Number(process.env.KEEP_ALIVE_TIMEOUT || 5000);
server.listen(PORT, HOST, () => console.log(`bench upstream on ${HOST}:${PORT}`));
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
