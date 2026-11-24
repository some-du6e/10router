// The Go gateway's client-IP rule (gateway/internal/clientip) is a port of
// custom-server.js's. Both are held to one table,
// gateway/internal/clientip/testdata/parity.json: the Go tests read it too.
import { describe, it, expect, afterAll } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import http from "node:http";

const require = createRequire(import.meta.url);
const SERVER_PATH = require.resolve("../../custom-server.js");
const originalCreateServer = http.createServer;
const savedTrustProxy = process.env.TRUST_PROXY;
const { __test__: server } = require(SERVER_PATH);
const cases = JSON.parse(readFileSync(new URL("../../gateway/internal/clientip/testdata/parity.json", import.meta.url), "utf8"));

afterAll(() => {
  http.createServer = originalCreateServer;
  delete require.cache[SERVER_PATH];
  if (savedTrustProxy === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = savedTrustProxy;
});

describe("client-IP rule parity with the Go gateway", () => {
  it("has the whole table", () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });

  for (const c of cases) {
    it(c.name, () => {
      process.env.TRUST_PROXY = c.trustProxy || "";
      expect(server.clientKeysFor(c.headers, c.socketIp)).toEqual(c.want.keys);
      expect(server.isOnThisMachine(c.headers, c.socketIp)).toBe(c.want.local);
      expect(server.isTunnelTraffic(c.headers, c.socketIp)).toBe(c.want.tunnel);
    });
  }
});
