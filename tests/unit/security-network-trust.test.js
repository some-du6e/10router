// Who counts as local, remote or rate-limited: the custom-server.js wrapper's
// verdict on loopback hops and the address it keys on, and the login limiter's
// lockout under concurrency, key rotation and the shared and local buckets.
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";
import http from "node:http";

const require = createRequire(import.meta.url);
const SERVER_PATH = require.resolve("../../custom-server.js");
const originalCreateServer = http.createServer;
const { isLoopbackHost, isOnThisMachine, clientIpFor, isTunnelTraffic, bridgeForwardHeaders } = require(SERVER_PATH).__test__;

afterAll(() => {
  // custom-server.js wraps http.createServer when loaded; leave the module as found.
  http.createServer = originalCreateServer;
  delete require.cache[SERVER_PATH];
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("custom-server wrapper: who is local and which address it keys on", () => {
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

  it("keeps a direct client on this machine local, 0.0.0.0 included", async () => {
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, `0.0.0.0:${port}`]) {
      const h = await get({ host });
      expect(h["x-9r-via-proxy"], host).toBeUndefined();
      expect(h["x-9r-real-ip"], host).toMatch(/^(::ffff:)?127\.0\.0\.1$/);
    }
  });

  it("treats a loopback hop with a non-loopback Host as a proxy, even with no forwarding headers", async () => {
    const h = await get({ host: "router.example.com" });
    expect(h["x-9r-via-proxy"]).toBe("1");
    // Nothing says who the client is, and it isn't the owner: a shared bucket.
    expect(h["x-9r-real-ip"]).toBe("unknown");
  });

  it("treats any forwarding header from a loopback hop as a proxy", async () => {
    for (const extra of [{ forwarded: "for=203.0.113.9" }, { "x-forwarded-proto": "https" }, { "cf-connecting-ip": "203.0.113.9" }, { "cf-ray": "abc-LAX" }, { "tailscale-funnel-request": "?1" }]) {
      const h = await get({ host: `localhost:${port}`, ...extra });
      expect(h["x-9r-via-proxy"], JSON.stringify(extra)).toBe("1");
    }
  });

  // socat, ssh -R or a TCP tunnel passes the client's bytes through: a remote
  // client that sends Host: localhost looks exactly like a local one.
  it("makes a header-less forwarder's clients remote only with TRUST_PROXY=true", async () => {
    const spoofed = { host: `localhost:${port}` };
    expect((await get(spoofed))["x-9r-via-proxy"]).toBeUndefined();
    vi.stubEnv("TRUST_PROXY", "true");
    const h = await get(spoofed);
    expect(h["x-9r-via-proxy"]).toBe("1");
    expect(h["x-9r-real-ip"]).toBe("unknown");
  });

  // Caddy, Traefik, cloudflared and Tailscale append to X-Forwarded-For and pass
  // a client's own X-Real-IP through untouched.
  it("keys on the appended hop behind an appending proxy, however the client rotates X-Real-IP", async () => {
    const keys = new Set();
    for (const realIp of ["198.51.100.1", "198.51.100.2", "203.0.113.7", "127.0.0.1"]) {
      const h = await get({ host: "router.example.com", "x-real-ip": realIp, "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200)}, 203.0.113.7` });
      keys.add(h["x-9r-real-ip"]);
    }
    expect([...keys]).toEqual(["203.0.113.7"]);
  });

  // nginx with only `proxy_set_header X-Real-IP $remote_addr` and no X-Forwarded-For.
  it("keys on X-Real-IP from a proxy that sets only that", async () => {
    const h = await get({ host: "router.example.com", "x-real-ip": "203.0.113.8" });
    expect(h["x-9r-real-ip"]).toBe("203.0.113.8");
  });

  it("never keys a proxied request on a loopback or non-address value from a header", async () => {
    for (const extra of [
      { "x-forwarded-for": "127.0.0.1" },
      { "x-forwarded-for": "127.0.0.1, ::1" },
      { "x-forwarded-for": "local" },
      { "x-forwarded-for": "unknown, 127.0.0.1" },
      { "x-real-ip": "127.0.0.1" },
      { "x-real-ip": "local" },
    ]) {
      const h = await get({ host: "router.example.com", ...extra });
      expect(h["x-9r-real-ip"], JSON.stringify(extra)).toBe("unknown");
      expect(h["x-9r-via-proxy"], JSON.stringify(extra)).toBe("1");
    }
  });

  it("stamps tunnel traffic from a loopback peer, and drops a client's own stamp", async () => {
    expect((await get({ host: "abc.trycloudflare.com", "cf-ray": "abc-LAX", "cf-connecting-ip": "203.0.113.9" }))["x-9r-via-tunnel"]).toBe("1");
    expect((await get({ host: "box.tail0.ts.net", "tailscale-funnel-request": "?1" }))["x-9r-via-tunnel"]).toBe("1");
    expect((await get({ host: "router.example.com", "x-9r-via-tunnel": "1" }))["x-9r-via-tunnel"]).toBeUndefined();
  });
});

describe("isOnThisMachine and clientIpFor", () => {
  const LOCAL_HOST = { host: "localhost:20128" };

  it.each([
    ["IPv4 loopback", "127.0.0.1", true],
    ["IPv6 loopback", "::1", true],
    ["IPv4-mapped loopback", "::ffff:127.0.0.1", true],
    ["a LAN peer", "192.168.1.20", false],
    ["no socket address", "", false],
  ])("a %s socket with no forwarding headers", (_name, socketIp, local) => {
    expect(isOnThisMachine(LOCAL_HOST, socketIp)).toBe(local);
    expect(clientIpFor(LOCAL_HOST, socketIp)).toBe(socketIp || "unknown");
  });

  it.each(["x-forwarded-for", "x-real-ip", "forwarded", "x-forwarded-host", "x-forwarded-proto", "cf-connecting-ip", "true-client-ip", "cf-ray", "tailscale-funnel-request"])(
    "%s from a loopback peer means a proxy",
    (name) => {
      expect(isOnThisMachine({ ...LOCAL_HOST, [name]: "203.0.113.9" }, "127.0.0.1")).toBe(false);
    }
  );

  it("uses Host only to rule a request out, never to rule it in", () => {
    expect(isOnThisMachine({}, "::1")).toBe(true);
    expect(isOnThisMachine({ host: "router.example.com" }, "127.0.0.1")).toBe(false);
    vi.stubEnv("TRUST_PROXY", "true");
    expect(isOnThisMachine({ host: "localhost" }, "127.0.0.1")).toBe(false);
    expect(isOnThisMachine({}, "127.0.0.1")).toBe(false);
  });

  it.each([
    ["the rightmost hop", { "x-forwarded-for": "198.51.100.1, 203.0.113.7" }, "203.0.113.7"],
    ["the rightmost non-loopback hop", { "x-forwarded-for": "198.51.100.1, 203.0.113.7, 127.0.0.1, ::1" }, "203.0.113.7"],
    ["past empty entries", { "x-forwarded-for": "203.0.113.7, , " }, "203.0.113.7"],
    ["past entries that aren't addresses", { "x-forwarded-for": "203.0.113.7, local, unknown" }, "203.0.113.7"],
    ["unknown for empty entries only", { "x-forwarded-for": " , ," }, "unknown"],
    ["unknown for an all-loopback chain", { "x-forwarded-for": "127.0.0.1, ::1, ::ffff:127.0.0.1, [::1]:5000" }, "unknown"],
    ["X-Forwarded-For over X-Real-IP", { "x-real-ip": "203.0.113.8", "x-forwarded-for": "198.51.100.1" }, "198.51.100.1"],
    ["X-Forwarded-For over CF-Connecting-IP", { "cf-connecting-ip": "203.0.113.8", "x-forwarded-for": "198.51.100.1" }, "198.51.100.1"],
    ["unknown, not X-Real-IP, when X-Forwarded-For has nothing usable", { "x-real-ip": "203.0.113.8", "x-forwarded-for": "127.0.0.1" }, "unknown"],
    ["X-Real-IP with no X-Forwarded-For", { "x-real-ip": "203.0.113.8" }, "203.0.113.8"],
    ["the last X-Real-IP when it was sent twice", { "x-real-ip": "198.51.100.1, 203.0.113.8" }, "203.0.113.8"],
    ["CF-Connecting-IP with neither", { "cf-connecting-ip": "203.0.113.9", "cf-ray": "abc-LAX" }, "203.0.113.9"],
    ["an IPv4 hop with a port", { "x-forwarded-for": "203.0.113.7:4444" }, "203.0.113.7"],
    ["an IPv6 hop", { "x-forwarded-for": "2001:db8::7" }, "2001:db8::7"],
    ["a bracketed IPv6 hop with a port", { "x-forwarded-for": "[2001:db8::7]:443" }, "2001:db8::7"],
    ["unknown when only Host says it is proxied", { host: "router.example.com" }, "unknown"],
  ])("behind a loopback proxy, keys on %s", (_name, headers, expected) => {
    expect(clientIpFor({ ...LOCAL_HOST, ...headers }, "127.0.0.1")).toBe(expected);
  });

  it("keys a direct remote peer on its socket, whatever it sends", () => {
    expect(clientIpFor({ "x-forwarded-for": "203.0.113.7", "x-real-ip": "203.0.113.8" }, "198.51.100.9")).toBe("198.51.100.9");
  });

  it("calls only a loopback peer with tunnel headers tunnel traffic", () => {
    expect(isTunnelTraffic({ "cf-ray": "x" }, "127.0.0.1")).toBe(true);
    expect(isTunnelTraffic({ "cf-connecting-ip": "203.0.113.9" }, "::1")).toBe(true);
    expect(isTunnelTraffic({ "tailscale-funnel-request": "?1" }, "127.0.0.1")).toBe(true);
    expect(isTunnelTraffic({ "cf-ray": "x" }, "198.51.100.9")).toBe(false);
    expect(isTunnelTraffic({ host: "abc.trycloudflare.com" }, "127.0.0.1")).toBe(false);
  });

  it.each([
    ["localhost", true],
    ["LOCALHOST:20128", true],
    ["127.0.0.1:20128", true],
    ["0.0.0.0", true],
    ["0.0.0.0:20128", true],
    ["[::1]:20128", true],
    ["::1", true],
    ["::ffff:127.0.0.1", true],
    ["[::ffff:127.0.0.1]:20128", true],
    ["[::1", false],
    ["router.example.com", false],
    ["127.0.0.2", false],
    ["localhost.example.com", false],
    ["", false],
  ])("isLoopbackHost(%j) is %s", (value, expected) => {
    expect(isLoopbackHost(value)).toBe(expected);
  });
});

describe("bridgeForwardHeaders follows the same rule as the wrapper", () => {
  const HANDSHAKE = { authorization: "Bearer sk-x" };

  it("marks a loopback handshake with a non-loopback Host and no forwarding header as remote", () => {
    expect(bridgeForwardHeaders({ ...HANDSHAKE, host: "router.example.com" }, "127.0.0.1", 2)["x-forwarded-for"]).toBe("127.0.0.1");
  });

  it("keeps a loopback handshake with a loopback Host local, unless TRUST_PROXY=true", () => {
    expect(bridgeForwardHeaders({ ...HANDSHAKE, host: "localhost:20128" }, "127.0.0.1", 2)["x-forwarded-for"]).toBeUndefined();
    vi.stubEnv("TRUST_PROXY", "true");
    expect(bridgeForwardHeaders({ ...HANDSHAKE, host: "localhost:20128" }, "127.0.0.1", 2)["x-forwarded-for"]).toBe("127.0.0.1");
  });
});

describe("login limiter", () => {
  let limiter;

  beforeEach(async () => {
    limiter = await import("../../src/lib/auth/loginLimiter.js");
    limiter.__test__.reset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const fail = (key) => {
    expect(limiter.reserveAttempt(key).ok).toBe(true);
    limiter.recordFail(key);
    limiter.releaseAttempt(key);
  };

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

  it("clears a key's failures on a success but keeps the other attempts still in flight", () => {
    const key = "203.0.113.5";
    for (let i = 0; i < 3; i++) limiter.reserveAttempt(key);
    limiter.recordFail(key);
    limiter.recordFail(key);
    limiter.recordSuccess(key); // one of the three
    limiter.releaseAttempt(key);
    // Two still in flight and no failures left: three more fit, a fourth doesn't.
    for (let i = 0; i < 3; i++) expect(limiter.reserveAttempt(key).ok).toBe(true);
    expect(limiter.reserveAttempt(key).ok).toBe(false);
  });

  it("clears a key's failures on a normal success", () => {
    fail("203.0.113.4");
    limiter.reserveAttempt("203.0.113.4");
    limiter.recordSuccess("203.0.113.4");
    limiter.releaseAttempt("203.0.113.4");
    for (let i = 0; i < 5; i++) expect(limiter.reserveAttempt("203.0.113.4").ok).toBe(true);
  });

  it("doesn't let failures from many addresses block a fresh address's login", () => {
    for (let i = 0; i < 200; i++) {
      const key = `198.51.0.${i}`;
      for (let n = 0; n < 4; n++) fail(key);
    }
    expect(limiter.reserveAttempt("203.0.113.200").ok).toBe(true);
  });

  it("keeps the local bucket apart: remote failures never lock it, local ones do", () => {
    for (let i = 0; i < 5; i++) fail("127.0.0.1");
    for (let i = 0; i < 5; i++) fail(limiter.SHARED_LOGIN_KEY);
    expect(limiter.reserveAttempt(limiter.LOCAL_LOGIN_KEY).ok).toBe(true);
    limiter.releaseAttempt(limiter.LOCAL_LOGIN_KEY);
    for (let i = 0; i < 5; i++) fail(limiter.LOCAL_LOGIN_KEY);
    expect(limiter.checkLock(limiter.LOCAL_LOGIN_KEY).locked).toBe(true);
  });

  it("locks the shared unknown bucket for a short fixed time that never escalates", () => {
    vi.useFakeTimers();
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < 5; i++) fail("unknown");
      expect(limiter.checkLock("unknown"), `round ${round}`).toEqual({ locked: true, retryAfter: 15 });
      vi.advanceTimersByTime(15_001);
      expect(limiter.checkLock("unknown").locked).toBe(false);
    }
    // An address bucket escalates: 30 s, then 2 min.
    for (let i = 0; i < 5; i++) fail("203.0.113.9");
    expect(limiter.checkLock("203.0.113.9").retryAfter).toBe(30);
    vi.advanceTimersByTime(30_001);
    for (let i = 0; i < 5; i++) fail("203.0.113.9");
    expect(limiter.checkLock("203.0.113.9").retryAfter).toBe(120);
  });

  it("forgets an address whose attempt left nothing to remember", () => {
    limiter.reserveAttempt("203.0.113.6");
    limiter.releaseAttempt("203.0.113.6");
    expect(limiter.__test__.size()).toBe(0);
  });

  it("lifts a lock when it runs out and forgets failures an hour after the last one", () => {
    vi.useFakeTimers();
    for (let i = 0; i < 5; i++) fail("203.0.113.7");
    expect(limiter.checkLock("203.0.113.7")).toEqual({ locked: true, retryAfter: 30 });
    vi.advanceTimersByTime(30_001);
    expect(limiter.checkLock("203.0.113.7").locked).toBe(false);

    for (let i = 0; i < 4; i++) fail("203.0.113.8");
    vi.advanceTimersByTime(60 * 60 * 1000 + 1);
    // The four old failures are gone: five fresh attempts fit.
    for (let i = 0; i < 5; i++) expect(limiter.reserveAttempt("203.0.113.8").ok).toBe(true);
  });

  it.each([
    ["an IPv4 address as is", "203.0.113.7", "203.0.113.7"],
    ["IPv6 on its /64", "2001:db8:1:2:aaaa:bbbb:cccc:dddd", "2001:db8:1:2::/64"],
    ["a compressed IPv6 address on its /64", "2001:db8::7", "2001:db8:0:0::/64"],
    ["leading zeros away", "2001:0db8:0001:0002::1", "2001:db8:1:2::/64"],
    ["an IPv4-mapped address as IPv4", "::ffff:203.0.113.7", "203.0.113.7"],
    ["an IPv6 address with a zone", "fe80::1%eth0", "fe80:0:0:0::/64"],
    ["the shared key as is", "unknown", "unknown"],
  ])("keys %s", (_name, address, expected) => {
    expect(limiter.limiterKeyFor(address)).toBe(expected);
  });

  it("puts two addresses in one IPv6 /64 in one bucket", () => {
    for (let i = 0; i < 5; i++) fail(limiter.limiterKeyFor(`2001:db8:1:2::${i + 1}`));
    expect(limiter.checkLock(limiter.limiterKeyFor("2001:db8:1:2:ffff::9")).locked).toBe(true);
    expect(limiter.checkLock(limiter.limiterKeyFor("2001:db8:1:3::1")).locked).toBe(false);
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
