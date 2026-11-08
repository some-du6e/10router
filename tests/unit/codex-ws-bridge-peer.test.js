// The Codex WebSocket bridge re-POSTs each turn to loopback. Whether that POST
// reads as local or remote decides whether the gateway asks for a key, so it
// must follow the handshake: a client on this machine stays local, everything
// else stays remote. Checks the forwarded header shape, then the guard's
// verdict on it through the real HTTP wrapper.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import http from "node:http";

const require = createRequire(import.meta.url);
const { __test__ } = require("../../custom-server.js");
const { bridgeForwardHeaders } = __test__;

const HANDSHAKE = { host: "localhost:20128", authorization: "Bearer sk-x", "x-api-key": "sk-x", upgrade: "websocket", "sec-websocket-key": "k", cookie: "auth_token=t" };

describe("bridgeForwardHeaders", () => {
  it("adds no forwarding header for a loopback client, so the turn stays local", () => {
    for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      const h = bridgeForwardHeaders(HANDSHAKE, ip, 10);
      expect(h["x-forwarded-for"], ip).toBeUndefined();
      expect(h.authorization).toBe("Bearer sk-x");
      expect(h.cookie).toBeUndefined();
      expect(h.upgrade).toBeUndefined();
    }
  });

  it("marks a remote peer as remote, keyed by its socket address", () => {
    const h = bridgeForwardHeaders({ ...HANDSHAKE, "x-forwarded-for": "127.0.0.1" }, "203.0.113.9", 10);
    expect(h["x-forwarded-for"]).toBe("203.0.113.9");
  });

  it("marks a turn that came through a local proxy or tunnel as remote, without trusting its forwarding value", () => {
    for (const extra of [{ "x-forwarded-for": "198.51.100.4, 10.0.0.1" }, { "x-real-ip": "198.51.100.4" }]) {
      const h = bridgeForwardHeaders({ ...HANDSHAKE, ...extra }, "127.0.0.1", 10);
      expect(h["x-forwarded-for"]).toBe("127.0.0.1");
      expect(h["x-real-ip"]).toBeUndefined();
    }
  });
});

describe("what the wrapper makes of a bridged turn", () => {
  let server;
  let port;
  let seen;

  beforeAll(async () => {
    server = http.createServer((req, res) => { seen = req.headers; res.end("ok"); });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
  });
  afterAll(() => new Promise((resolve) => server.close(resolve)));

  function post(headers) {
    return new Promise((resolve, reject) => {
      const r = http.request({ host: "127.0.0.1", port, path: "/backend-api/codex/responses", method: "POST", headers }, (res) => { res.resume(); res.on("end", resolve); });
      r.on("error", reject);
      r.end("{}");
    });
  }

  it("a loopback client's turn arrives without the via-proxy mark (local)", async () => {
    await post(bridgeForwardHeaders(HANDSHAKE, "127.0.0.1", 2));
    expect(seen["x-9r-via-proxy"]).toBeUndefined();
  });

  it("a remote or proxied client's turn arrives marked via-proxy (remote)", async () => {
    await post(bridgeForwardHeaders(HANDSHAKE, "203.0.113.9", 2));
    expect(seen["x-9r-via-proxy"]).toBe("1");
    await post(bridgeForwardHeaders({ ...HANDSHAKE, "x-forwarded-for": "198.51.100.4" }, "127.0.0.1", 2));
    expect(seen["x-9r-via-proxy"]).toBe("1");
  });
});

describe("bridge error frames and wiring", () => {
  const { bridgeErrorFrame, bridgeCodexTurn } = __test__;

  it("wraps a string error (the gateway's own refusals) as an object Codex can read", () => {
    expect(JSON.parse(bridgeErrorFrame(JSON.stringify({ error: "API key required for remote API access" }), 401)))
      .toEqual({ type: "error", error: { message: "API key required for remote API access", type: "invalid_request_error" } });
    expect(JSON.parse(bridgeErrorFrame(JSON.stringify({ error: { message: "m", type: "t" } }), 400)).error).toEqual({ message: "m", type: "t" });
    expect(JSON.parse(bridgeErrorFrame("not json", 502)).error).toEqual({ message: "Request failed with status 502", type: "server_error" });
  });

  it("falls back to a placeholder address for a remote peer with no address", () => {
    expect(bridgeForwardHeaders({}, "", 1)["x-forwarded-for"]).toBe("unknown");
  });

  it("bridgeCodexTurn sends the turn with bridgeForwardHeaders' shape, and a rejected turn as a wrapped error frame", async () => {
    const received = [];
    const upstream = http.createServer((req, res) => {
      received.push(req.headers);
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "API key required for remote API access" }));
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const port = upstream.address().port;
    const turn = (peerIp, headers = HANDSHAKE) => new Promise((resolve) => {
      const frames = [];
      bridgeCodexTurn({ type: "response.create", model: "m", input: "hi" }, port, headers, peerIp, (f) => frames.push(f), () => resolve(frames));
    });
    try {
      const localFrames = await turn("127.0.0.1");
      expect(received[0]["x-9r-via-proxy"]).toBeUndefined();
      expect(received[0].authorization).toBe("Bearer sk-x");
      expect(JSON.parse(localFrames[0]).error).toEqual({ message: "API key required for remote API access", type: "invalid_request_error" });
      await turn("203.0.113.9");
      expect(received[1]["x-9r-via-proxy"]).toBe("1");
    } finally {
      await new Promise((resolve) => upstream.close(resolve));
    }
  });
});
