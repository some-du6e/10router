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

let release;
const released = new Promise((resolve) => { release = resolve; });
// Stands in for the app: answers the bridge's loopback POST with a Responses
// stream whose last event waits for release().
const server = http.createServer(async (req, res) => {
  for await (const chunk of req) void chunk;
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ type: "response.created" })}\n\n`);
  await released;
  res.end(`data: ${JSON.stringify({ type: "response.completed" })}\n\n`);
});
server.on("upgrade", (_req, socket) => socket.destroy());
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(() => resolve()));
});

describe("drain wiring in custom-server.js", () => {
  it("finishes a bridged Codex turn, refuses new connections and upgrades, then exits", async () => {
    const ws = await openWs(port);
    ws.send({ type: "response.create", model: "m", input: "hi" });
    await vi.waitFor(() => expect(ws.events.map((e) => e.type)).toContain("response.created"));

    const exit = vi.fn(() => [...ws.events]);
    drain.setExit(exit);
    const quiet = vi.spyOn(console, "log").mockImplementation(() => {});
    onTestFinished(() => quiet.mockRestore());
    drain.start("SIGTERM");
    // The bridge's loopback POST, and the WebSocket turn's own hold.
    expect(drain.inflight).toBe(2);

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
    release();
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
