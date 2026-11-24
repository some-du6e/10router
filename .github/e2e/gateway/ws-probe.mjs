// One Codex turn over the Responses WebSocket transport, the way Codex sends
// it: upgrade, one `response.create` text frame, then read event frames until
// response.completed (or a close / timeout). Prints one JSON line: the
// handshake status, the event types in order, and the text deltas.
//   node ws-probe.mjs <http base URL> <model> [api key]
// A hand-rolled client (masked text frames out, plain frames in) so it can
// send Authorization on the upgrade.
import http from "node:http";
import crypto from "node:crypto";

const [base, model, apiKey] = process.argv.slice(2);
const url = new URL("/backend-api/codex/responses", base);
const headers = {
  connection: "Upgrade",
  upgrade: "websocket",
  "sec-websocket-version": "13",
  "sec-websocket-key": crypto.randomBytes(16).toString("base64"),
};
if (apiKey) headers.authorization = `Bearer ${apiKey}`;
// WS_HOST sends another Host than the URL's (a client claiming to be local).
if (process.env.WS_HOST) headers.host = process.env.WS_HOST;
const out = { status: null, events: [], text: "" };
const finish = () => {
  console.log(JSON.stringify(out));
  process.exit(0);
};
setTimeout(() => {
  out.timedOut = true;
  finish();
}, 30000).unref();

function frame(text) {
  const payload = Buffer.from(text);
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
  else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
  return Buffer.concat([header, mask, masked]);
}

const req = http.request({ host: url.hostname, port: url.port, path: url.pathname, headers });
req.on("response", (res) => {
  out.status = res.statusCode;
  finish();
});
req.on("error", (e) => {
  out.error = e.message;
  finish();
});
req.on("upgrade", (res, socket, head) => {
  out.status = res.statusCode;
  socket.write(frame(JSON.stringify({ type: "response.create", model, input: [{ role: "user", content: "ping" }] })));
  let buf = head;
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }
      if (buf.length < offset + len) return;
      const payload = buf.subarray(offset, offset + len);
      buf = buf.subarray(offset + len);
      if (opcode === 0x8) {
        out.closed = payload.length >= 2 ? payload.readUInt16BE(0) : true;
        return finish();
      }
      if (opcode !== 0x1) continue;
      let event;
      try {
        event = JSON.parse(payload.toString("utf8"));
      } catch {
        continue;
      }
      out.events.push(event.type);
      if (event.type === "response.output_text.delta") out.text += event.delta || "";
      if (event.type === "response.completed" || event.type === "response.failed" || event.type === "error") return finish();
    }
  });
  socket.on("close", finish);
});
req.end();
