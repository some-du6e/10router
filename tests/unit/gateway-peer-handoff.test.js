// Behind the Go gateway (GATEWAY_MODE=proxy) every request reaches
// custom-server.js from loopback, so the gateway hands over the client's own
// peer in x-9r-gw-peer-ip/-port with a token it started this process with.
// Boot a real server through the wrapper with that token set and check the
// handed peer drives every stamp, and that nothing without the token does.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import http from "node:http";

const require = createRequire(import.meta.url);
const SERVER_PATH = require.resolve("../../custom-server.js");
const originalCreateServer = http.createServer;
const TOKEN = "f".repeat(64);
const savedTrustProxy = process.env.TRUST_PROXY;

let server;
let port;
let seen;

beforeAll(async () => {
  delete require.cache[SERVER_PATH];
  process.env.GATEWAY_PEER_TOKEN = TOKEN;
  require(SERVER_PATH);
  server = http.createServer((req, res) => {
    seen = { ...req.headers };
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  http.createServer = originalCreateServer;
  delete require.cache[SERVER_PATH];
  delete process.env.GATEWAY_PEER_TOKEN;
  if (savedTrustProxy === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = savedTrustProxy;
});

function get(headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/v1/models", headers: { host: "localhost", ...headers } }, (res) => {
      res.resume();
      res.on("end", () => resolve(seen));
    });
    req.on("error", reject);
    req.end();
  });
}

const handed = (ip, extra = {}) => ({ "x-9r-gw-token": TOKEN, "x-9r-gw-peer-ip": ip, "x-9r-gw-peer-port": "51000", ...extra });

describe("custom-server behind the Go gateway", () => {
  it("takes the token out of the environment", () => {
    expect(process.env.GATEWAY_PEER_TOKEN).toBeUndefined();
  });

  it("uses the handed peer for a remote client", async () => {
    const h = await get(handed("203.0.113.7"));
    expect(h["x-9r-real-ip"]).toBe("203.0.113.7");
    expect(h["x-9r-via-proxy"]).toBe("1");
    expect(h["x-9r-proxy-hop"]).toBeUndefined();
    expect(h["x-9r-socket-ip"]).toBe("203.0.113.7");
    expect(h["x-9r-socket-port"]).toBe("51000");
    for (const name of ["x-9r-gw-token", "x-9r-gw-peer-ip", "x-9r-gw-peer-port"]) expect(h[name]).toBeUndefined();
  });

  it("ignores a remote client's forwarding headers, as without the gateway", async () => {
    const h = await get(handed("203.0.113.7", { "x-forwarded-for": "127.0.0.1", "x-real-ip": "127.0.0.1" }));
    expect(h["x-9r-real-ip"]).toBe("203.0.113.7");
    expect(h["x-9r-via-proxy"]).toBe("1");
  });

  it("keeps a client on this machine local", async () => {
    const h = await get(handed("127.0.0.1"));
    expect(h["x-9r-real-ip"]).toBe("127.0.0.1");
    expect(h["x-9r-via-proxy"]).toBeUndefined();
  });

  it("reads a TRUST_PROXY-listed peer's forwarding headers", async () => {
    process.env.TRUST_PROXY = "172.17.0.0/16";
    try {
      const h = await get(handed("172.17.0.1", { "x-forwarded-for": "198.51.100.2" }));
      expect(h["x-9r-real-ip"]).toBe("198.51.100.2");
      expect(h["x-9r-proxy-hop"]).toBe("listed");
    } finally {
      delete process.env.TRUST_PROXY;
    }
  });

  it("does not trust a wrong token", async () => {
    const h = await get(handed("203.0.113.7", { "x-9r-gw-token": "e".repeat(64) }));
    // The socket (loopback) is used, and the forged headers are gone.
    expect(h["x-9r-real-ip"]).toBe("127.0.0.1");
    expect(h["x-9r-gw-peer-ip"]).toBeUndefined();
    expect(h["x-9r-gw-token"]).toBeUndefined();
  });

  it("does not trust a token of the wrong length", async () => {
    const h = await get(handed("203.0.113.7", { "x-9r-gw-token": TOKEN.slice(1) }));
    expect(h["x-9r-real-ip"]).toBe("127.0.0.1");
  });

  it("does not take a handed peer that is not an address", async () => {
    const h = await get(handed("not-an-ip"));
    expect(h["x-9r-real-ip"]).toBe("127.0.0.1");
    expect(h["x-9r-gw-peer-ip"]).toBeUndefined();
  });
});
