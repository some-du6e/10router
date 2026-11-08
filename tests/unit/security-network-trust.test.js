// Who counts as local, remote or rate-limited: the custom-server.js wrapper's
// verdict on loopback hops, its h2c and Codex WebSocket resource limits, and
// the login limiter's lockout under concurrency and key rotation.
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import { createRequire } from "node:module";
import http from "node:http";
import net from "node:net";

const require = createRequire(import.meta.url);
require("../../custom-server.js");

describe("custom-server loopback hop classification", () => {
  let server;
  let port;
  let seen;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen = req.headers;
      res.end("ok");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
  });
  afterAll(() => new Promise((resolve) => server.close(resolve)));
  afterEach(() => {
    delete process.env.BEHIND_PROXY;
  });

  function get(headers) {
    return new Promise((resolve, reject) => {
      const r = http.request({ host: "127.0.0.1", port, path: "/", headers }, (res) => {
        res.resume();
        res.on("end", () => resolve(seen));
      });
      r.on("error", reject);
      r.end();
    });
  }

  it("keeps a direct client on this machine local", async () => {
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]) {
      const h = await get({ host });
      expect(h["x-9r-via-proxy"], host).toBeUndefined();
    }
  });

  it("treats a loopback hop with a non-loopback Host as a proxy, even with no forwarding headers", async () => {
    const h = await get({ host: "router.example.com" });
    expect(h["x-9r-via-proxy"]).toBe("1");
  });

  it("treats any forwarding header from a loopback hop as a proxy", async () => {
    for (const extra of [{ forwarded: "for=203.0.113.9" }, { "x-forwarded-proto": "https" }, { "cf-connecting-ip": "203.0.113.9" }]) {
      const h = await get({ host: `localhost:${port}`, ...extra });
      expect(h["x-9r-via-proxy"], JSON.stringify(extra)).toBe("1");
    }
  });

  it("treats every loopback hop as a proxy when BEHIND_PROXY=true", async () => {
    process.env.BEHIND_PROXY = "true";
    const h = await get({ host: `localhost:${port}` });
    expect(h["x-9r-via-proxy"]).toBe("1");
  });

  it("keys on the rightmost non-loopback X-Forwarded-For hop, ignoring a client-sent X-Real-IP", async () => {
    const h = await get({ host: "router.example.com", "x-real-ip": "198.51.100.1", "x-forwarded-for": "198.51.100.2, 203.0.113.7, 127.0.0.1" });
    expect(h["x-9r-real-ip"]).toBe("203.0.113.7");
  });

  it("falls back to X-Real-IP only when there is no X-Forwarded-For", async () => {
    const h = await get({ host: "router.example.com", "x-real-ip": "203.0.113.8" });
    expect(h["x-9r-real-ip"]).toBe("203.0.113.8");
  });
});

describe("custom-server bridged Codex turn follows the handshake's Host", () => {
  const { bridgeForwardHeaders } = require("../../custom-server.js").__test__;

  it("marks a turn whose handshake came through a Host-preserving proxy as remote", () => {
    const h = bridgeForwardHeaders({ host: "router.example.com", authorization: "Bearer sk-x" }, "127.0.0.1", 2);
    expect(h["x-forwarded-for"]).toBe("127.0.0.1");
  });
});

function rawRequest(port, lines, { body, timeoutMs = 2_000 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
      socket.write(lines.join("\r\n") + "\r\n\r\n");
      if (body) socket.write(body);
    });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error("timed out"));
    });
    socket.on("data", (c) => chunks.push(c));
    socket.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("error", reject);
  });
}

describe("custom-server h2c body limit", () => {
  let server;
  let port;
  let handled;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      handled = true;
      res.end("ok");
    });
    server.on("upgrade", (_req, socket) => socket.destroy());
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
  });
  afterAll(() => new Promise((resolve) => server.close(resolve)));

  it("refuses a declared body above the proxy body limit before buffering it", async () => {
    handled = false;
    const response = await rawRequest(port, [
      "POST /v1/chat/completions HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      "Connection: Upgrade, HTTP2-Settings",
      "Upgrade: h2c",
      "HTTP2-Settings: AAMAAABkAAQCAAAAAAIAAAAA",
      `Content-Length: ${200 * 1024 * 1024}`,
    ]);
    expect(response).toMatch(/^HTTP\/1\.1 413 /);
    expect(handled).toBe(false);
  });

  it("parses the proxy body size setting", () => {
    const { parseByteSize } = require("../../custom-server.js").__test__;
    expect(parseByteSize("128mb")).toBe(128 * 1024 * 1024);
    expect(parseByteSize("1gb")).toBe(1024 ** 3);
    expect(parseByteSize("500")).toBe(500);
    expect(parseByteSize("lots")).toBeNull();
  });
});

describe("custom-server Codex WebSocket connection cap", () => {
  let server;
  let port;
  const sockets = [];

  beforeAll(async () => {
    server = http.createServer((_req, res) => res.end("ok"));
    server.on("upgrade", (_req, socket) => socket.destroy());
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
  });
  afterAll(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  function upgrade() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
        socket.write([
          "GET /backend-api/codex/responses HTTP/1.1",
          `Host: 127.0.0.1:${port}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        ].join("\r\n") + "\r\n\r\n");
      });
      sockets.push(socket);
      socket.once("data", (c) => resolve(c.toString("utf8").split("\r\n")[0]));
      socket.on("error", reject);
    });
  }

  it("refuses handshakes past the concurrent connection cap", async () => {
    const statuses = [];
    for (let i = 0; i < 64; i++) statuses.push(await upgrade());
    expect(statuses.every((s) => s.startsWith("HTTP/1.1 101"))).toBe(true);
    expect(await upgrade()).toMatch(/^HTTP\/1\.1 503/);
  });
});

describe("login limiter", () => {
  let limiter;

  beforeEach(async () => {
    limiter = await import("../../src/lib/auth/loginLimiter.js");
    limiter.__resetLoginLimiterForTests();
  });

  it("caps concurrent attempts in flight for one key at the lockout threshold", () => {
    const results = Array.from({ length: 20 }, () => limiter.reserveAttempt("203.0.113.1"));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
  });

  it("locks after five failures that were all in flight together", () => {
    for (let i = 0; i < 5; i++) expect(limiter.reserveAttempt("203.0.113.2").ok).toBe(true);
    for (let i = 0; i < 5; i++) {
      limiter.recordFail("203.0.113.2");
      limiter.releaseAttempt("203.0.113.2");
    }
    expect(limiter.checkLock("203.0.113.2").locked).toBe(true);
  });

  it("does not let a success inside a burst clear the lock the burst set", () => {
    for (let i = 0; i < 5; i++) limiter.reserveAttempt("203.0.113.3");
    for (let i = 0; i < 4; i++) {
      limiter.recordFail("203.0.113.3");
      limiter.releaseAttempt("203.0.113.3");
    }
    limiter.recordFail("203.0.113.3");
    limiter.recordSuccess("203.0.113.3");
    expect(limiter.checkLock("203.0.113.3").locked).toBe(true);
  });

  it("throttles password attempts across keys when the key rotates", () => {
    let i = 0;
    for (; i < 30; i++) {
      const ip = `198.51.100.${i}`;
      expect(limiter.reserveAttempt(ip).ok).toBe(true);
      limiter.recordFail(ip);
      limiter.releaseAttempt(ip);
    }
    const next = limiter.reserveAttempt("198.51.100.250");
    expect(next.ok).toBe(false);
    expect(next.retryAfter).toBeGreaterThan(0);
  });

  it("clears a key's failures on a normal success", () => {
    limiter.reserveAttempt("203.0.113.4");
    limiter.recordFail("203.0.113.4");
    limiter.releaseAttempt("203.0.113.4");
    limiter.reserveAttempt("203.0.113.4");
    limiter.recordSuccess("203.0.113.4");
    limiter.releaseAttempt("203.0.113.4");
    for (let i = 0; i < 5; i++) expect(limiter.reserveAttempt("203.0.113.4").ok).toBe(true);
  });
});

describe("dashboard framing", () => {
  it("forbids framing every page", async () => {
    const config = (await import("../../next.config.mjs")).default;
    const rules = await config.headers();
    const all = rules.find((r) => r.source === "/:path*");
    const byKey = Object.fromEntries(all.headers.map((h) => [h.key.toLowerCase(), h.value]));
    expect(byKey["x-frame-options"]).toBe("DENY");
    expect(byKey["content-security-policy"]).toContain("frame-ancestors 'none'");
  });
});
