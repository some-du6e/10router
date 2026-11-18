// The password login route's use of the limiter: every reservation it takes is
// released exactly once, a refused reservation is answered with 429 and never
// released, and whether the login came from this machine reaches the limiter.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PEER_TOKEN = "peer-token-fixture";
const PASSWORD = "correct-horse-battery";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  setDashboardAuthCookie: vi.fn(),
  getAuthBootstrapState: vi.fn(),
  getBootstrapSecret: vi.fn(),
  limiter: {
    reserveAttempt: vi.fn(),
    releaseAttempt: vi.fn(),
    recordFail: vi.fn(),
    recordSuccess: vi.fn(),
    checkLock: vi.fn(),
  },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init = {}) => ({ body, status: init.status ?? 200, headers: init.headers ?? {} }),
    next: () => ({ next: true }),
    redirect: (url) => ({ status: 307, url }),
  },
}));
vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings, validateApiKey: vi.fn() }));
vi.mock("@/shared/utils/machineId", () => ({ getConsistentMachineId: vi.fn(async () => "cli-token") }));
vi.mock("@/lib/db/helpers/metaStore.js", () => ({ getMeta: vi.fn(async () => "0"), setMeta: vi.fn() }));
vi.mock("@/lib/auth/dashboardSession", () => ({
  setDashboardAuthCookie: mocks.setDashboardAuthCookie,
  verifyDashboardAuthToken: vi.fn(),
  getDashboardAuthSession: vi.fn(),
}));
vi.mock("@/lib/auth/setupState", () => ({
  getAuthBootstrapState: mocks.getAuthBootstrapState,
  getBootstrapSecret: mocks.getBootstrapSecret,
  needsSetup: vi.fn(async () => false),
}));
vi.mock("@/lib/auth/loginLimiter", () => ({
  ...mocks.limiter,
  LOCAL_LOGIN_KEY: "local",
  // The real rule: the stamped address when the wrapper proved it, else one bucket.
  getClientIp: (request) => (request.headers.get("x-9r-peer-token") === PEER_TOKEN && request.headers.get("x-9r-real-ip")) || "unknown",
}));

const { POST: login } = await import("../../src/app/api/auth/login/route.js");

function loginRequest({ body = JSON.stringify({ password: PASSWORD }), headers = {} } = {}) {
  return new Request("http://localhost:20128/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost:20128", ...headers },
    body,
  });
}

// What custom-server.js stamps for a client on this machine, and for one behind a proxy.
const LOCAL = { "x-9r-peer-token": PEER_TOKEN, "x-9r-real-ip": "127.0.0.1" };
const REMOTE = { "x-9r-peer-token": PEER_TOKEN, "x-9r-real-ip": "203.0.113.7", "x-9r-via-proxy": "1", host: "router.example.com" };

describe("login route and the limiter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NINEROUTER_PEER_TOKEN", PEER_TOKEN);
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.getAuthBootstrapState.mockResolvedValue("env");
    mocks.getBootstrapSecret.mockResolvedValue(PASSWORD);
    mocks.setDashboardAuthCookie.mockResolvedValue(undefined);
    mocks.limiter.reserveAttempt.mockReturnValue({ ok: true });
    mocks.limiter.recordFail.mockReturnValue({ remainingBeforeLock: 4 });
    mocks.limiter.checkLock.mockReturnValue({ locked: false });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("answers a refused reservation with 429 and Retry-After, and releases nothing", async () => {
    mocks.limiter.reserveAttempt.mockReturnValue({ ok: false, retryAfter: 7 });
    const response = await login(loginRequest({ headers: REMOTE }));
    expect(response.status).toBe(429);
    expect(response.headers["Retry-After"]).toBe("7");
    expect(response.body.retryAfter).toBe(7);
    expect(mocks.limiter.releaseAttempt).not.toHaveBeenCalled();
    expect(mocks.getSettings).not.toHaveBeenCalled();
  });

  it("releases once after a successful login", async () => {
    const response = await login(loginRequest({ headers: REMOTE }));
    expect(response.status).toBe(200);
    expect(mocks.limiter.recordSuccess).toHaveBeenCalledWith("203.0.113.7");
    expect(mocks.limiter.releaseAttempt).toHaveBeenCalledTimes(1);
    expect(mocks.limiter.releaseAttempt).toHaveBeenCalledWith("203.0.113.7");
  });

  it("releases once after a wrong password, and counts the failure", async () => {
    const response = await login(loginRequest({ body: JSON.stringify({ password: "wrong" }), headers: REMOTE }));
    expect(response.status).toBe(401);
    expect(mocks.limiter.recordFail).toHaveBeenCalledWith("203.0.113.7");
    expect(mocks.limiter.releaseAttempt).toHaveBeenCalledTimes(1);
  });

  it("releases once after a 403 (tunnel access off)", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: true, tunnelUrl: "https://abc.trycloudflare.com" });
    const response = await login(loginRequest({ headers: { ...REMOTE, host: "abc.trycloudflare.com" } }));
    expect(response.status).toBe(403);
    expect(mocks.limiter.releaseAttempt).toHaveBeenCalledTimes(1);
  });

  it("releases once after a 403 (setup still required)", async () => {
    mocks.getAuthBootstrapState.mockResolvedValue("setup");
    const response = await login(loginRequest({ headers: REMOTE }));
    expect(response.status).toBe(403);
    expect(mocks.limiter.releaseAttempt).toHaveBeenCalledTimes(1);
  });

  it("releases once when the body isn't JSON (500)", async () => {
    const response = await login(loginRequest({ body: "{not json", headers: REMOTE }));
    expect(response.status).toBe(500);
    expect(mocks.limiter.releaseAttempt).toHaveBeenCalledTimes(1);
  });

  it("releases once when something throws mid-login", async () => {
    mocks.getSettings.mockRejectedValue(new Error("db down"));
    expect((await login(loginRequest({ headers: REMOTE }))).status).toBe(500);
    expect(mocks.limiter.releaseAttempt).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    mocks.limiter.reserveAttempt.mockReturnValue({ ok: true });
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.setDashboardAuthCookie.mockRejectedValue(new Error("cookie store"));
    expect((await login(loginRequest({ headers: REMOTE }))).status).toBe(500);
    expect(mocks.limiter.releaseAttempt).toHaveBeenCalledTimes(1);
  });

  it("limits a login from this machine in its own bucket", async () => {
    const response = await login(loginRequest({ body: JSON.stringify({ password: "wrong" }), headers: LOCAL }));
    expect(response.status).toBe(401);
    expect(mocks.limiter.reserveAttempt).toHaveBeenCalledWith("local");
    expect(mocks.limiter.recordFail).toHaveBeenCalledWith("local");
    expect(mocks.limiter.releaseAttempt).toHaveBeenCalledTimes(1);
    expect(mocks.limiter.releaseAttempt).toHaveBeenCalledWith("local");
  });

  it("keys a proxied login on its address, never on the local bucket", async () => {
    await login(loginRequest({ headers: REMOTE }));
    expect(mocks.limiter.reserveAttempt).toHaveBeenCalledWith("203.0.113.7");
    // A forwarded request claiming a loopback peer address is still remote.
    vi.clearAllMocks();
    mocks.limiter.reserveAttempt.mockReturnValue({ ok: true });
    await login(loginRequest({ headers: { ...REMOTE, "x-9r-real-ip": "127.0.0.1" } }));
    expect(mocks.limiter.reserveAttempt).toHaveBeenCalledWith("127.0.0.1");
    expect(mocks.limiter.reserveAttempt).not.toHaveBeenCalledWith("local");
  });

  it("blocks login for traffic stamped as tunnel traffic, whatever the stored tunnel URL", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: true, tunnelUrl: "https://old.trycloudflare.com" });
    const response = await login(loginRequest({ headers: { ...REMOTE, host: "new.trycloudflare.com", "x-9r-via-tunnel": "1" } }));
    expect(response.status).toBe(403);
    // Without the wrapper's proof the stamp means nothing.
    const forged = await login(loginRequest({ headers: { ...REMOTE, "x-9r-peer-token": "guess", host: "new.trycloudflare.com", "x-9r-via-tunnel": "1" } }));
    expect(forged.status).toBe(200);
  });

  it("blocks login on the tunnel host however the Host is written", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: true, tunnelUrl: "https://abc.trycloudflare.com" });
    for (const host of ["ABC.trycloudflare.com", "abc.trycloudflare.com.", "abc.trycloudflare.com.:443"]) {
      const response = await login(loginRequest({ headers: { ...REMOTE, host } }));
      expect(response.status, host).toBe(403);
    }
  });

  it("logs in normally when a stored tunnel URL is malformed", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: true, tunnelUrl: "not a url", tailscaleUrl: "::" });
    const response = await login(loginRequest({ headers: REMOTE }));
    expect(response.status).toBe(200);
  });
});
