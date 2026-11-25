// The Node half of the Go gateway's shadow compare (gateway/internal/shadow,
// docs/GO_GATEWAY.md "Phase 2c"): custom-server.js runs a request the
// gateway proved and tagged with x-9r-shadow-id in the shadow's context, and
// each upstream send proxyAwareFetch makes inside it is reported to the
// gateway with the peer token. Boot a real server through the wrapper, and a
// stand-in for the gateway's report endpoint.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import http from "node:http";

const require = createRequire(import.meta.url);
const SERVER_PATH = require.resolve("../../custom-server.js");
const originalCreateServer = http.createServer;
const TOKEN = "e".repeat(64);
const SHADOW = Symbol.for("10router.gatewayShadow");
const VERIFY = Symbol.for("10router.verifyGatewayToken");
const ID = "0123456789abcdef0123456789abcdef";
const saved = {};
const ENV = ["GATEWAY_PEER_TOKEN", "GATEWAY_MODE", "GATEWAY_SHADOW", "GATEWAY_SHADOW_URL", "TRUST_PROXY"];

let reports = [];
let reportServer;
let server;
let port;
let seen;
let upstream;
let upstreamPort;

const listen = (s) => new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve(s.address().port)));

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  reportServer = originalCreateServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      reports.push({ path: req.url, token: req.headers["x-9r-shadow-token"], body: JSON.parse(raw) });
      res.statusCode = 204;
      res.end();
    });
  });
  const reportPort = await listen(reportServer);
  upstream = originalCreateServer((req, res) => {
    req.resume();
    req.on("end", () => res.end("{}"));
  });
  upstreamPort = await listen(upstream);

  delete require.cache[SERVER_PATH];
  delete process.env.TRUST_PROXY;
  process.env.GATEWAY_PEER_TOKEN = TOKEN;
  process.env.GATEWAY_MODE = "native";
  process.env.GATEWAY_SHADOW = "1";
  process.env.GATEWAY_SHADOW_URL = `http://127.0.0.1:${reportPort}/_gateway/shadow`;
  require(SERVER_PATH);
  const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
  server = http.createServer(async (req, res) => {
    seen = { ...req.headers };
    const target = `http://127.0.0.1:${upstreamPort}/v1/messages`;
    // As the executor sends: a plain headers object and the body's bytes.
    const send = (body) => proxyAwareFetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "key-1", "anthropic-version": "2023-06-01" },
      body,
    });
    const mode = req.headers["x-test-mode"];
    if (mode === "nested") {
      // A second copy of proxyFetch.js patches fetch over the first, so one
      // send passes through proxyAwareFetch twice: reported once.
      await globalThis[SHADOW].around(target, { method: "POST", headers: { a: "outer" }, body: "outer" }, () => send("inner"));
    } else if (mode === "twice") {
      await send(Buffer.from("first"));
      await send(Buffer.from("second"));
    } else {
      await send(Buffer.from(JSON.stringify({ model: "m1", text: "é" }), "utf8"));
    }
    res.end("ok");
  });
  port = await listen(server);
});

afterAll(async () => {
  await Promise.all([server, reportServer, upstream].map((s) => new Promise((resolve) => s.close(resolve))));
  http.createServer = originalCreateServer;
  delete require.cache[SERVER_PATH];
  delete globalThis[SHADOW];
  delete globalThis[VERIFY];
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function post(headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/v1/messages", headers: { host: "localhost", ...headers } }, (res) => {
      res.resume();
      res.on("end", resolve);
    });
    req.on("error", reject);
    req.end("{}");
  });
}

const proven = { "x-9r-gw-token": TOKEN, "x-9r-gw-peer-ip": "203.0.113.7", "x-9r-gw-peer-port": "51000" };
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

describe("custom-server's shadow tap", () => {
  it("takes the report URL out of the environment", () => {
    expect(process.env.GATEWAY_SHADOW_URL).toBeUndefined();
  });

  it("reports each send of a request the gateway proved and tagged", async () => {
    reports = [];
    await post({ ...proven, "x-9r-shadow-id": ID });
    await settle();
    expect(seen["x-9r-shadow-id"]).toBeUndefined();
    expect(reports).toHaveLength(1);
    const [r] = reports;
    expect(r.path).toBe("/_gateway/shadow");
    expect(r.token).toBe(TOKEN);
    expect(r.body).toMatchObject({
      id: ID,
      url: `http://127.0.0.1:${upstreamPort}/v1/messages`,
      method: "POST",
      headersKind: "object",
      headers: [["Content-Type", "application/json"], ["x-api-key", "key-1"], ["anthropic-version", "2023-06-01"]],
      bodyKind: "bytes",
    });
    expect(Buffer.from(r.body.body, "base64").toString("utf8")).toBe(JSON.stringify({ model: "m1", text: "é" }));
  });

  it("reports a send that passes through proxyAwareFetch twice once, as the outer call made it", async () => {
    reports = [];
    await post({ ...proven, "x-9r-shadow-id": ID, "x-test-mode": "nested" });
    await settle();
    expect(reports).toHaveLength(1);
    expect(reports[0].body).toMatchObject({ headers: [["a", "outer"]], bodyKind: "string" });
    expect(Buffer.from(reports[0].body.body, "base64").toString()).toBe("outer");
  });

  it("reports each of a request's sends", async () => {
    reports = [];
    await post({ ...proven, "x-9r-shadow-id": ID, "x-test-mode": "twice" });
    await settle();
    expect(reports.map((r) => Buffer.from(r.body.body, "base64").toString())).toEqual(["first", "second"]);
  });

  it("reports nothing for an id the gateway didn't prove, or one not its shape", async () => {
    reports = [];
    await post({ "x-9r-shadow-id": ID });
    await post({ ...proven, "x-9r-gw-token": "f".repeat(64), "x-9r-shadow-id": ID });
    await post({ ...proven, "x-9r-shadow-id": "not-an-id" });
    await post({ ...proven });
    await settle();
    expect(reports).toHaveLength(0);
    expect(seen["x-9r-shadow-id"]).toBeUndefined();
  });

  it("lets the app check the gateway's token without seeing it", () => {
    const verify = globalThis[VERIFY];
    expect(typeof verify).toBe("function");
    expect(verify(TOKEN)).toBe(true);
    expect(verify("f".repeat(64))).toBe(false);
    expect(verify(TOKEN.slice(1))).toBe(false);
    expect(verify(undefined)).toBe(false);
  });
});
