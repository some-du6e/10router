// The launcher's readiness proof, end to end: custom-server.js stamps the TCP
// peer, /api/health signs the challenge for that peer with the launch nonce,
// and the launcher checks it against its own end of the connection.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import http from "node:http";
import os from "node:os";

// A non-loopback IPv4 address of this machine, for a launcher bound to its LAN
// address; none on a host with only loopback.
const lanAddress = Object.values(os.networkInterfaces()).flat()
  .find((entry) => entry && entry.family === "IPv4" && !entry.internal)?.address;

const require = createRequire(import.meta.url);
const cli = require("../../cli/src/cli/utils/serverProcess.js");

const nonce = cli.newLaunchNonce();
let GET;
let server;
let routes;
const servers = [];

function listen(handler, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    servers.push(s);
    s.listen({ host, port: 0 }, () => resolve(s.address().port));
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

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

// A peer on another address, through the real wrapper: its forwarding headers
// are read, and its Host may be a proxy's, only when TRUST_PROXY lists it and
// it sent a forwarding header.
// CI runners have a LAN address, so there a missing one fails rather than skips.
describe("custom-server proxy-hop stamp for a non-loopback peer", () => {
  it.skipIf(!lanAddress && !process.env.CI)("stamps x-9r-proxy-hop only on a listed peer that sent a forwarding header", async () => {
    expect(lanAddress, "no non-loopback IPv4 address on this machine").toBeTruthy();
    let seen;
    const port = await listen((req, res) => { seen = req.headers; res.end("ok"); }, lanAddress);
    const send = (forwarding = { "x-forwarded-for": "203.0.113.7" }) => new Promise((resolve) => {
      const req = http.request({ host: lanAddress, port, agent: false, headers: { host: "localhost", ...forwarding } }, (res) => { res.resume(); res.on("end", resolve); });
      req.end();
    });

    await send();
    expect(seen["x-9r-via-proxy"]).toBe("1");
    expect(seen["x-9r-proxy-hop"]).toBeUndefined();
    expect(seen["x-9r-real-ip"]).toBe(lanAddress);

    vi.stubEnv("TRUST_PROXY", `${lanAddress}/32`);
    await send();
    expect(seen["x-9r-proxy-hop"]).toBe("listed");
    expect(seen["x-9r-real-ip"]).toBe("203.0.113.7");
    // Any forwarding header makes it a proxy hop, not only X-Forwarded-For.
    await send({ "x-real-ip": "203.0.113.8" });
    expect(seen["x-9r-proxy-hop"]).toBe("listed");
    expect(seen["x-9r-real-ip"]).toBe("203.0.113.8");
    await send({ forwarded: "for=203.0.113.9" });
    expect(seen["x-9r-proxy-hop"]).toBe("listed");
  });

  // Docker with the bridge gateway listed: the owner's own browser on
  // http://localhost:20128 comes in through the published port from the same
  // gateway, with no forwarding header. Nothing rewrote its Host. A client's own
  // x-9r-proxy-hop is dropped, not passed on.
  it.skipIf(!lanAddress && !process.env.CI)("keeps a listed peer with no forwarding header a direct peer", async () => {
    expect(lanAddress, "no non-loopback IPv4 address on this machine").toBeTruthy();
    let seen;
    const port = await listen((req, res) => { seen = req.headers; res.end("ok"); }, lanAddress);
    vi.stubEnv("TRUST_PROXY", `${lanAddress}/32`);
    for (const headers of [{ host: "localhost:20128" }, { host: "localhost:20128", "x-9r-proxy-hop": "listed" }]) {
      await new Promise((resolve) => {
        const req = http.request({ host: lanAddress, port, agent: false, headers }, (res) => { res.resume(); res.on("end", resolve); });
        req.end();
      });
      expect(seen["x-9r-via-proxy"], JSON.stringify(headers)).toBe("1");
      expect(seen["x-9r-proxy-hop"], JSON.stringify(headers)).toBeUndefined();
      expect(seen["x-9r-real-ip"], JSON.stringify(headers)).toBe(lanAddress);
    }
  });
});

describe("custom-server peer socket", () => {
  async function stampsFor(headers) {
    let seen;
    const port = await listen((req, res) => { seen = req.headers; res.end("ok"); });
    let localPort;
    await new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, agent: false, headers }, (res) => { res.resume(); res.on("end", resolve); });
      req.on("socket", (s) => s.on("connect", () => { localPort = s.localPort; }));
      req.end();
    });
    return { seen, localPort };
  }

  it("stamps the socket's address and source port and drops client-supplied ones", async () => {
    const { seen, localPort } = await stampsFor({ "x-9r-socket-ip": "203.0.113.1", "x-9r-socket-port": "1", "x-9r-real-port": "1" });
    expect(seen["x-9r-socket-ip"]).toMatch(/^(::ffff:)?127\.0\.0\.1$/);
    expect(seen["x-9r-socket-port"]).toBe(String(localPort));
    expect(seen["x-9r-real-port"]).toBeUndefined();
  });

  it("stamps the socket, not the forwarded address the limiter keys on", async () => {
    const { seen, localPort } = await stampsFor({ "x-forwarded-for": "203.0.113.7" });
    expect(seen["x-9r-real-ip"]).toBe("203.0.113.7");
    expect(seen["x-9r-socket-ip"]).toMatch(/^(::ffff:)?127\.0\.0\.1$/);
    expect(seen["x-9r-socket-port"]).toBe(String(localPort));
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
    const bare = await GET(new Request("http://127.0.0.1/api/health", { headers: { [cli.LAUNCH_CHALLENGE_HEADER]: challenge, "x-9r-socket-ip": "127.0.0.1", "x-9r-socket-port": "5000" } }));
    expect(bare.headers.get(cli.LAUNCH_PROOF_HEADER)).toBeNull();
  });

  // The proof follows the socket, not x-9r-real-ip / x-9r-via-proxy, which
  // TRUST_PROXY and a non-loopback bind change for the launcher's own connection.
  it("signs for the stamped socket whatever the limiter key and proxy marker say", async () => {
    const challenge = "0123456789abcdef0123456789abcdef";
    const res = await GET(new Request("http://192.0.2.10/api/health", {
      headers: {
        [cli.LAUNCH_CHALLENGE_HEADER]: challenge, "x-9r-real-ip": "unknown", "x-9r-via-proxy": "1",
        "x-9r-socket-ip": "192.0.2.10", "x-9r-socket-port": "5000", "x-9r-peer-token": process.env.NINEROUTER_PEER_TOKEN,
      },
    }));
    const salt = res.headers.get(cli.LAUNCH_SALT_HEADER);
    expect(res.headers.get(cli.LAUNCH_PROOF_HEADER)).toBe(cli.launchProof(nonce, challenge, "192.0.2.10", 5000, salt));
  });

  // TRUST_PROXY=true makes no loopback peer local and keys it on `unknown`.
  it("passes for the launcher's own connection with TRUST_PROXY=true", async () => {
    vi.stubEnv("TRUST_PROXY", "true");
    expect(await cli.provesLaunchNonce({ host: "127.0.0.1", port: server, nonce })).toBe(true);
  });

  // `--host <LAN address>` with that address in TRUST_PROXY: the launcher's
  // socket is listed but sends no forwarding header, so it is a direct peer
  // keyed on itself.
  // CI runners have a LAN address, so there a missing one fails rather than skips.
  it.skipIf(!lanAddress && !process.env.CI)("passes for a launcher on a LAN bind that a TRUST_PROXY list covers", async () => {
    expect(lanAddress, "no non-loopback IPv4 address on this machine").toBeTruthy();
    const lanServer = await listen(healthRoute, lanAddress);
    vi.stubEnv("TRUST_PROXY", `${lanAddress}/32`);
    expect(await cli.provesLaunchNonce({ host: lanAddress, port: lanServer, nonce })).toBe(true);
    vi.stubEnv("TRUST_PROXY", "");
    expect(await cli.provesLaunchNonce({ host: lanAddress, port: lanServer, nonce })).toBe(true);
  });
});
