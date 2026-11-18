// Who counts as local, remote or rate-limited: the custom-server.js wrapper's
// verdict on loopback hops and the address it keys on, and the login limiter's
// lockout under concurrency, key rotation and remote attempts on the owner's bucket.
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";
import http from "node:http";

const require = createRequire(import.meta.url);
const SERVER_PATH = require.resolve("../../custom-server.js");
const originalCreateServer = http.createServer;
const { isLoopbackHost, isOnThisMachine, clientIpFor } = require(SERVER_PATH).__test__;

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
    for (const extra of [{ forwarded: "for=203.0.113.9" }, { "x-forwarded-proto": "https" }, { "cf-connecting-ip": "203.0.113.9" }]) {
      const h = await get({ host: `localhost:${port}`, ...extra });
      expect(h["x-9r-via-proxy"], JSON.stringify(extra)).toBe("1");
    }
  });

  it("treats every loopback hop as a proxy when TRUST_PROXY=true", async () => {
    vi.stubEnv("TRUST_PROXY", "true");
    const h = await get({ host: `localhost:${port}` });
    expect(h["x-9r-via-proxy"]).toBe("1");
    expect(h["x-9r-real-ip"]).toBe("unknown");
  });

  // nginx with only `proxy_set_header X-Real-IP $remote_addr`: the client's own
  // X-Forwarded-For passes through untouched.
  it("keys on X-Real-IP from a proxy that sets only that, whatever X-Forwarded-For the client sent", async () => {
    const h = await get({ host: "router.example.com", "x-real-ip": "203.0.113.8", "x-forwarded-for": "198.51.100.66" });
    expect(h["x-9r-real-ip"]).toBe("203.0.113.8");
  });

  // A proxy with only `$proxy_add_x_forwarded_for`: the client's entries come first.
  it("keys on the hop a proxy that only appends X-Forwarded-For added, not the client's entries", async () => {
    const h = await get({ host: "router.example.com", "x-forwarded-for": "198.51.100.2, 203.0.113.7" });
    expect(h["x-9r-real-ip"]).toBe("203.0.113.7");
  });

  it("never keys a proxied request on a loopback address from a header", async () => {
    for (const extra of [
      { "x-forwarded-for": "127.0.0.1" },
      { "x-forwarded-for": "127.0.0.1, ::1" },
      { "x-real-ip": "127.0.0.1" },
      { "x-real-ip": "::1", "x-forwarded-for": "localhost" },
    ]) {
      const h = await get({ host: "router.example.com", ...extra });
      expect(h["x-9r-real-ip"], JSON.stringify(extra)).toBe("unknown");
      expect(h["x-9r-via-proxy"], JSON.stringify(extra)).toBe("1");
    }
    const h = await get({ host: "router.example.com", "x-real-ip": "127.0.0.1", "x-forwarded-for": "203.0.113.7" });
    expect(h["x-9r-real-ip"]).toBe("203.0.113.7");
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

  it.each(["x-forwarded-for", "x-real-ip", "forwarded", "x-forwarded-host", "x-forwarded-proto", "cf-connecting-ip", "true-client-ip"])(
    "%s from a loopback peer means a proxy",
    (name) => {
      expect(isOnThisMachine({ ...LOCAL_HOST, [name]: "203.0.113.9" }, "127.0.0.1")).toBe(false);
    }
  );

  it("treats a request with no Host from loopback as local", () => {
    expect(isOnThisMachine({}, "::1")).toBe(true);
  });

  it.each([
    ["the rightmost hop", { "x-forwarded-for": "198.51.100.1, 203.0.113.7" }, "203.0.113.7"],
    ["the rightmost non-loopback hop", { "x-forwarded-for": "198.51.100.1, 203.0.113.7, 127.0.0.1, ::1" }, "203.0.113.7"],
    ["past empty entries", { "x-forwarded-for": "203.0.113.7, , " }, "203.0.113.7"],
    ["unknown for empty entries only", { "x-forwarded-for": " , ," }, "unknown"],
    ["unknown for an all-loopback chain", { "x-forwarded-for": "127.0.0.1, ::1, ::ffff:127.0.0.1, [::1]:5000" }, "unknown"],
    ["X-Real-IP over X-Forwarded-For", { "x-real-ip": "203.0.113.8", "x-forwarded-for": "198.51.100.1" }, "203.0.113.8"],
    ["the last X-Real-IP when it was sent twice", { "x-real-ip": "198.51.100.1, 203.0.113.8" }, "203.0.113.8"],
    ["X-Forwarded-For past a loopback X-Real-IP", { "x-real-ip": "127.0.0.1", "x-forwarded-for": "203.0.113.7" }, "203.0.113.7"],
    ["an IPv6 hop", { "x-forwarded-for": "2001:db8::7" }, "2001:db8::7"],
    ["unknown when only Host says it is proxied", { host: "router.example.com" }, "unknown"],
  ])("behind a loopback proxy, keys on %s", (_name, headers, expected) => {
    expect(clientIpFor({ ...LOCAL_HOST, ...headers }, "127.0.0.1")).toBe(expected);
  });

  it("keys a direct remote peer on its socket, whatever it sends", () => {
    expect(clientIpFor({ "x-forwarded-for": "203.0.113.7", "x-real-ip": "203.0.113.8" }, "198.51.100.9")).toBe("198.51.100.9");
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

describe("login limiter", () => {
  let limiter;

  beforeEach(async () => {
    limiter = await import("../../src/lib/auth/loginLimiter.js");
    limiter.__test__.reset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const fail = (ip) => {
    expect(limiter.reserveAttempt(ip).ok).toBe(true);
    limiter.recordFail(ip);
    limiter.releaseAttempt(ip);
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
    const ip = "203.0.113.5";
    for (let i = 0; i < 3; i++) limiter.reserveAttempt(ip);
    limiter.recordFail(ip);
    limiter.recordFail(ip);
    limiter.recordSuccess(ip); // one of the three
    limiter.releaseAttempt(ip);
    // Two still in flight and no failures left: three more fit, a fourth doesn't.
    for (let i = 0; i < 3; i++) expect(limiter.reserveAttempt(ip).ok).toBe(true);
    expect(limiter.reserveAttempt(ip).ok).toBe(false);
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
      const ip = `198.51.${Math.floor(i / 250)}.${i % 250}`;
      for (let n = 0; n < 4; n++) fail(ip);
    }
    expect(limiter.reserveAttempt("203.0.113.200").ok).toBe(true);
  });

  it("never locks a login from this machine, even when its address's bucket is locked", () => {
    for (let i = 0; i < 5; i++) fail("127.0.0.1");
    expect(limiter.checkLock("127.0.0.1").locked).toBe(true);
    expect(limiter.reserveAttempt("127.0.0.1", { local: true })).toEqual({ ok: true });
  });

  it("keeps no record of logins from this machine", () => {
    limiter.reserveAttempt("127.0.0.1", { local: true });
    limiter.recordFail("127.0.0.1", { local: true });
    limiter.releaseAttempt("127.0.0.1", { local: true });
    expect(limiter.__test__.size()).toBe(0);
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
