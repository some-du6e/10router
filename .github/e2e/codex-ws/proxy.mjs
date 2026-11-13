// A reverse proxy in front of 10router that does to each request what a CDN
// proxy does on its way to the origin (Cloudflare among them): it sets
// `accept-encoding: gzip, br` and appends the client to `x-forwarded-for`,
// WebSocket upgrades included. Requests and upgrades pass through otherwise
// unchanged. Logs one JSON line per request (method, path, status), never
// header values.
//   PROXY_PORT=20129 TARGET_PORT=20128 node proxy.mjs
import http from "node:http";

const PORT = Number(process.env.PROXY_PORT || 20129);
const TARGET = Number(process.env.TARGET_PORT || 20128);
const log = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));

function originHeaders(req) {
  const headers = { ...req.headers };
  headers["accept-encoding"] = "gzip, br";
  const peer = req.socket.remoteAddress || "";
  headers["x-forwarded-for"] = headers["x-forwarded-for"] ? `${headers["x-forwarded-for"]}, ${peer}` : peer;
  return headers;
}

const server = http.createServer((req, res) => {
  const upstream = http.request({ host: "127.0.0.1", port: TARGET, path: req.url, method: req.method, headers: originHeaders(req) }, (up) => {
    log({ kind: "http", method: req.method, path: req.url.split("?")[0], status: up.statusCode });
    res.writeHead(up.statusCode, up.rawHeaders);
    up.pipe(res);
  });
  upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(upstream);
});

server.on("upgrade", (req, socket, head) => {
  const upstream = http.request({ host: "127.0.0.1", port: TARGET, path: req.url, method: req.method, headers: originHeaders(req) });
  const drop = () => { socket.destroy(); };
  socket.on("error", drop);
  upstream.on("error", drop);
  upstream.on("response", (res) => {
    log({ kind: "upgrade", path: req.url.split("?")[0], status: res.statusCode });
    socket.end(`HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\nConnection: close\r\n\r\n`);
  });
  upstream.on("upgrade", (res, originSocket, originHead) => {
    log({ kind: "upgrade", path: req.url.split("?")[0], status: res.statusCode });
    const lines = [`HTTP/1.1 ${res.statusCode} ${res.statusMessage}`];
    for (let i = 0; i < res.rawHeaders.length; i += 2) lines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`);
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (originHead.length) socket.write(originHead);
    if (head.length) originSocket.write(head);
    originSocket.on("error", drop);
    originSocket.on("close", drop);
    socket.on("close", () => originSocket.destroy());
    originSocket.pipe(socket);
    socket.pipe(originSocket);
  });
  upstream.end();
});

server.listen(PORT, "127.0.0.1", () => log({ event: "listening", port: PORT, target: TARGET }));
