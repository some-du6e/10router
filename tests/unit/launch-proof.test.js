// The launcher's readiness proof, end to end: custom-server.js stamps the TCP
// peer, /api/health signs the challenge for that peer with the launch nonce,
// and the launcher checks it against its own end of the connection.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import http from "node:http";

const require = createRequire(import.meta.url);
const cli = require("../../cli/src/cli/utils/serverProcess.js");

const nonce = cli.newLaunchNonce();
let GET;
let server;
let routes;
const servers = [];

function listen(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    servers.push(s);
    s.listen({ host: "127.0.0.1", port: 0 }, () => resolve(s.address().port));
  });
}

// Serves /api/health through the real route, as Next would behind custom-server.
async function healthRoute(req, res) {
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => name.startsWith("x-9r-")));
  const response = await GET(new Request(`http://127.0.0.1${req.url}`, { headers }));
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(await response.text());
}

// What custom-server.js alone did with the nonce, read before launchProof.js
// (which would also take it out of the env) is loaded.
let envAfterBoot;
let globalAfterBoot;

beforeAll(async () => {
  process.env[cli.LAUNCH_NONCE_ENV] = nonce;
  require("../../custom-server.js");
  envAfterBoot = process.env[cli.LAUNCH_NONCE_ENV];
  globalAfterBoot = globalThis[Symbol.for("10router.launchNonce")];
  routes = await import("../../src/lib/launchProof.js");
  ({ GET } = await import("../../src/app/api/health/route.js"));
  server = await listen(healthRoute);
});

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
});

describe("launch nonce", () => {
  // cloudflared, tailscale and the updater inherit the server's env.
  it("custom-server takes it out of the env at boot", () => {
    expect(envAfterBoot).toBeUndefined();
    expect(globalAfterBoot).toBe(nonce);
    expect(process.env[cli.LAUNCH_NONCE_ENV]).toBeUndefined();
    expect(routes.takeLaunchNonce()).toBe(nonce);
  });

  it("uses the same names and proof as the launcher", () => {
    expect([routes.LAUNCH_NONCE_ENV, routes.LAUNCH_CHALLENGE_HEADER, routes.LAUNCH_PROOF_HEADER, routes.LAUNCH_SALT_HEADER])
      .toEqual([cli.LAUNCH_NONCE_ENV, cli.LAUNCH_CHALLENGE_HEADER, cli.LAUNCH_PROOF_HEADER, cli.LAUNCH_SALT_HEADER]);
    expect(routes.launchProof("n", "c", "::ffff:127.0.0.1", 5000, "s")).toBe(cli.launchProof("n", "c", "127.0.0.1", 5000, "s"));
  });
});

describe("custom-server peer port", () => {
  it("stamps the socket's source port and drops a client-supplied one", async () => {
    let seen;
    const port = await listen((req, res) => { seen = req.headers; res.end("ok"); });
    let localPort;
    await new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, agent: false, headers: { "x-9r-real-port": "1" } }, (res) => { res.resume(); res.on("end", resolve); });
      req.on("socket", (s) => s.on("connect", () => { localPort = s.localPort; }));
      req.end();
    });
    expect(seen["x-9r-real-port"]).toBe(String(localPort));
  });

  it("stamps no port when x-9r-real-ip is a forwarded address", async () => {
    let seen;
    const port = await listen((req, res) => { seen = req.headers; res.end("ok"); });
    await new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, agent: false, headers: { "x-9r-real-port": "1", "x-forwarded-for": "203.0.113.7" } }, (res) => { res.resume(); res.on("end", resolve); });
      req.end();
    });
    expect(seen["x-9r-real-ip"]).toBe("203.0.113.7");
    expect(seen["x-9r-real-port"]).toBeUndefined();
  });
});

describe("/api/health launch proof", () => {
  it("passes for the launcher's own direct connection", async () => {
    expect(await cli.provesLaunchNonce({ host: "127.0.0.1", port: server, nonce })).toBe(true);
  });

  it("fails for a different nonce", async () => {
    expect(await cli.provesLaunchNonce({ host: "127.0.0.1", port: server, nonce: cli.newLaunchNonce() })).toBe(false);
  });

  // A local impostor on the port the launcher dials forwards the challenge to
  // the real server over its own connection (say via the LAN address) and
  // hands back the answer. The proof is for the impostor's connection.
  it("fails when an impostor relays the challenge to the real server", async () => {
    const impostor = await listen((req, res) => {
      const relay = http.request({
        host: "127.0.0.1", port: server, path: "/api/health", agent: false,
        headers: { [cli.LAUNCH_CHALLENGE_HEADER]: req.headers[cli.LAUNCH_CHALLENGE_HEADER] },
      }, (upstream) => {
        upstream.resume();
        res.writeHead(200, {
          [cli.LAUNCH_SALT_HEADER]: upstream.headers[cli.LAUNCH_SALT_HEADER],
          [cli.LAUNCH_PROOF_HEADER]: upstream.headers[cli.LAUNCH_PROOF_HEADER],
        });
        res.end("{}");
      });
      relay.end();
    });
    expect(await cli.provesLaunchNonce({ host: "127.0.0.1", port: impostor, nonce })).toBe(false);
  });

  it("returns a fresh salt each time, so answers can't be correlated", async () => {
    const salts = [];
    for (let i = 0; i < 2; i++) {
      await new Promise((resolve) => {
        const req = http.request({ host: "127.0.0.1", port: server, path: "/api/health", agent: false, headers: { [cli.LAUNCH_CHALLENGE_HEADER]: "0123456789abcdef0123456789abcdef" } }, (res) => {
          salts.push(res.headers[cli.LAUNCH_SALT_HEADER]);
          res.resume();
          res.on("end", resolve);
        });
        req.end();
      });
    }
    expect(salts[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(salts[1]).not.toBe(salts[0]);
  });

  it("gives no proof without custom-server's stamp", async () => {
    const challenge = "0123456789abcdef0123456789abcdef";
    const bare = await GET(new Request("http://127.0.0.1/api/health", { headers: { [cli.LAUNCH_CHALLENGE_HEADER]: challenge, "x-9r-real-ip": "127.0.0.1", "x-9r-real-port": "5000" } }));
    expect(bare.headers.get(cli.LAUNCH_PROOF_HEADER)).toBeNull();
  });

  // A loopback reverse proxy: x-9r-real-ip is the forwarded client, the port
  // would be the proxy's, so custom-server stamps no port and nothing is proved.
  it("gives no proof through a proxy hop", async () => {
    const proof = await new Promise((resolve) => {
      const req = http.request({
        host: "127.0.0.1", port: server, path: "/api/health", agent: false,
        headers: { [cli.LAUNCH_CHALLENGE_HEADER]: "0123456789abcdef0123456789abcdef", "x-forwarded-for": "203.0.113.7" },
      }, (res) => { res.resume(); res.on("end", () => resolve(res.headers[cli.LAUNCH_PROOF_HEADER])); });
      req.end();
    });
    expect(proof).toBeUndefined();
  });

  // `--host <LAN address>`: the launcher dials that address, so its socket is
  // not loopback and custom-server marks it x-9r-via-proxy. Still its own
  // direct connection, so it gets a proof for that peer.
  it("proves a direct peer that is not on this machine", async () => {
    const challenge = "0123456789abcdef0123456789abcdef";
    const res = await GET(new Request("http://192.0.2.10/api/health", {
      headers: {
        [cli.LAUNCH_CHALLENGE_HEADER]: challenge, "x-9r-real-ip": "192.0.2.10", "x-9r-real-port": "5000",
        "x-9r-peer-token": process.env.NINEROUTER_PEER_TOKEN, "x-9r-via-proxy": "1",
      },
    }));
    const salt = res.headers.get(cli.LAUNCH_SALT_HEADER);
    expect(res.headers.get(cli.LAUNCH_PROOF_HEADER)).toBe(cli.launchProof(nonce, challenge, "192.0.2.10", 5000, salt));
  });
});
