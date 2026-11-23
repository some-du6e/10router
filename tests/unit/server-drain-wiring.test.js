// The drain as custom-server.js wires it: every server its http.createServer
// wrapper makes is closed by the drain, an upgrade during the drain is refused,
// and a Codex WebSocket turn bridged when the drain starts still delivers its
// last event before the process exits.
import { afterAll, describe, expect, it, onTestFinished, vi } from "vitest";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// The drain reads it once, at load; a value from the environment would change it.
delete process.env.SHUTDOWN_DRAIN_TIMEOUT_MS;
delete require.cache[require.resolve("../../custom-server.js")];
const { drain } = require("../../custom-server.js").__test__;

function maskedText(text) {
  const payload = Buffer.from(text, "utf8");
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
  else {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  }
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

function openWs(port) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, path: "/backend-api/codex/responses",
      headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": crypto.randomBytes(16).toString("base64") },
    });
    req.on("error", reject);
    req.on("response", (res) => reject(new Error(`no upgrade: HTTP ${res.statusCode}`)));
    req.on("upgrade", (_res, socket) => {
      const events = [];
      let buf = Buffer.alloc(0);
      socket.on("data", (d) => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          if (buf.length < 2) break;
          let len = buf[1] & 0x7f;
          let off = 2;
          if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
          if (buf.length < off + len) break;
          const opcode = buf[0] & 0x0f;
          const payload = buf.subarray(off, off + len);
          buf = buf.subarray(off + len);
          if (opcode === 0x8) events.push({ close: payload.readUInt16BE(0) });
          if (opcode === 0x1) events.push(JSON.parse(payload.toString()));
        }
      });
      resolve({ events, send: (frame) => socket.write(maskedText(JSON.stringify(frame))), socket });
    });
    req.end();
  });
}

const gates = new Map();
const gate = (id) => {
  if (!gates.has(id)) {
    let open;
    const promise = new Promise((resolve) => { open = resolve; });
    gates.set(id, { promise, open });
  }
  return gates.get(id);
};
const release = (id = "turn") => gate(id).open();
// What reached the stand-in app, past the wrapper.
const hits = [];
// Stands in for the app. /v1/slow?id=x streams until release(x); a request
// marked x-test-quick is answered at once; anything else is the bridge's
// loopback POST, answered with a Responses stream whose last event waits for
// release("turn").
const server = http.createServer(async (req, res) => {
  hits.push(`${req.method} ${req.url}`);
  for await (const chunk of req) void chunk;
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/v1/slow") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.write("first;");
    await gate(url.searchParams.get("id")).promise;
    res.end("last;");
    return;
  }
  if (req.headers["x-test-quick"]) {
    res.end("served");
    return;
  }
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ type: "response.created" })}\n\n`);
  await gate("turn").promise;
  res.end(`data: ${JSON.stringify({ type: "response.completed" })}\n\n`);
});

// A keep-alive socket with a slow request in flight, so the drain doesn't
// close it as idle.
async function busySocket(id) {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  const state = { raw: "", socket, closed: new Promise((resolve) => socket.on("close", resolve)) };
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => { state.raw += chunk; });
  socket.on("error", () => {});
  socket.write(`GET /v1/slow?id=${id} HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n`);
  await vi.waitFor(() => expect(state.raw).toContain("first;"));
  return state;
}

const arrived = (match) => new Promise((resolve) => {
  const listener = (req) => {
    if (`${req.method} ${req.url}` !== match) return;
    server.off("request", listener);
    resolve();
  };
  server.on("request", listener);
});
server.on("upgrade", (_req, socket) => socket.destroy());
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(() => resolve()));
});

describe("drain wiring in custom-server.js", () => {
  it("finishes a bridged Codex turn, refuses new connections, requests and upgrades, admits its own loopback POST, then exits", async () => {
    const a = await busySocket("a");
    const b = await busySocket("b");
    const c = await busySocket("c");
    const ws = await openWs(port);
    ws.send({ type: "response.create", model: "m", input: "hi" });
    await vi.waitFor(() => expect(ws.events.map((e) => e.type)).toContain("response.created"));

    const exit = vi.fn(() => [...ws.events]);
    drain.setExit(exit);
    const quiet = vi.spyOn(console, "log").mockImplementation(() => {});
    onTestFinished(() => quiet.mockRestore());
    // custom-server.js hands the drain logSync: its lines go straight to fd 2,
    // not through console.log, which a full stdout pipe would hold back.
    const fs = require("node:fs");
    const realWriteSync = fs.writeSync;
    const stderrLines = [];
    const toStderr = vi.spyOn(fs, "writeSync").mockImplementation((fd, data, ...rest) => {
      if (fd !== 2) return realWriteSync(fd, data, ...rest);
      stderrLines.push(String(data));
      return Buffer.byteLength(data);
    });
    onTestFinished(() => toStderr.mockRestore());
    drain.start("SIGTERM");
    expect(stderrLines.some((line) => line.startsWith("[Shutdown] SIGTERM: draining"))).toBe(true);
    expect(quiet.mock.calls.some(([line]) => String(line).startsWith("[Shutdown]"))).toBe(false);
    // The three slow requests, the bridge's loopback POST, and the WebSocket turn's own hold.
    expect(drain.inflight).toBe(5);

    // A /v1 request on an open keep-alive socket: 503 from the wrapper, never the
    // app. Once with a forged peer token, once with none.
    const refused = [
      [a, "a", "GET /v1/new?forged=1", "x-9r-peer-token: forged\r\n"],
      [c, "c", "GET /v1/new?token=none", ""],
    ];
    for (const [sock, id, line, extra] of refused) {
      const saw = arrived(line);
      sock.socket.write(`${line} HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n${extra}\r\n`);
      await saw;
      release(id);
      await sock.closed;
      expect(sock.raw, line).toContain("last;");
      expect(sock.raw.slice(sock.raw.indexOf("HTTP/1.1", 1)), line).toMatch(/^HTTP\/1\.1 503 [\s\S]*server_draining/);
      expect(hits, line).not.toContain(line);
    }

    // The right token from a peer that isn't loopback is refused too.
    const remoteRes = { writeHead: vi.fn(), end: vi.fn(), once: vi.fn() };
    server.emit(
      "request",
      {
        method: "POST", url: "/backend-api/codex/responses?remote=1",
        headers: { "x-9r-peer-token": process.env.NINEROUTER_PEER_TOKEN },
        socket: { remoteAddress: "203.0.113.9" },
      },
      remoteRes
    );
    expect(remoteRes.writeHead.mock.calls[0][0]).toBe(503);
    expect(hits).not.toContain("POST /backend-api/codex/responses?remote=1");

    // This process's own loopback POST (it carries the peer token) is still served.
    const sawOwn = arrived("POST /backend-api/codex/responses?own=1");
    b.socket.write(
      "POST /backend-api/codex/responses?own=1 HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n" +
        `x-9r-peer-token: ${process.env.NINEROUTER_PEER_TOKEN}\r\nx-test-quick: 1\r\nContent-Length: 2\r\n\r\n{}`
    );
    await sawOwn;
    release("b");
    await vi.waitFor(() => expect(b.raw).toContain("served"));
    expect(b.raw).not.toContain(" 503 ");
    expect(hits).toContain("POST /backend-api/codex/responses?own=1");
    // Left: the WebSocket turn's loopback POST and its hold.
    await vi.waitFor(() => expect(drain.inflight).toBe(2));

    // The wrapper registered the server with the drain, so the port is closed.
    await expect(new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolve("connected"); });
      socket.once("error", reject);
    })).rejects.toMatchObject({ code: "ECONNREFUSED" });

    // An upgrade that still reaches the server is refused before the bridge.
    const fakeSocket = { end: vi.fn(), destroy: vi.fn() };
    server.emit("upgrade", { url: "/backend-api/codex/responses", headers: { upgrade: "websocket" } }, fakeSocket, Buffer.alloc(0));
    expect(fakeSocket.end.mock.calls[0][0]).toMatch(/^HTTP\/1\.1 503 /);

    expect(exit).not.toHaveBeenCalled();
    release("turn");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(exit.mock.calls[0][0]).toBe(0);
    // What the client had when the process would have exited.
    expect(exit.mock.results[0].value.map((e) => e.type)).toEqual(["response.created", "response.completed"]);

    // A new turn on the open socket during the drain starts no upstream work.
    ws.send({ type: "response.create", model: "m", input: "again" });
    await vi.waitFor(() => expect(ws.events.some((e) => e.close)).toBe(true));
    const refusal = ws.events.find((e) => e.type === "error");
    expect(refusal.status).toBe(503);
    expect(refusal.error.code).toBe("server_draining");
    expect(ws.events.at(-1)).toEqual({ close: 1012 });
    ws.socket.destroy();
  });
});
