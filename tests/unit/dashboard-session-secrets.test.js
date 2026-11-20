import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SignJWT } from "jose";

const state = vi.hoisted(() => ({
  settings: {},
  meta: new Map(),
  dataDir: "",
  cookies: {},
  setupPending: false,
  bootstrap: "claimed",
}));

vi.mock("@/lib/dataDir", () => ({
  get DATA_DIR() {
    return state.dataDir;
  },
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => ({ ...state.settings })),
  updateSettings: vi.fn(async (updates) => {
    state.settings = { ...state.settings, ...updates };
    return state.settings;
  }),
}));

vi.mock("@/lib/db/helpers/metaStore.js", () => ({
  getMeta: vi.fn(async (key, fallback = null) => (state.meta.has(key) ? state.meta.get(key) : fallback)),
  setMeta: vi.fn(async (key, value) => {
    state.meta.set(key, String(value));
  }),
}));

vi.mock("@/lib/auth/setupState", () => ({
  getBootstrapSecret: vi.fn(),
  getEnvInitialPassword: vi.fn(() => null),
  needsSetup: vi.fn(async () => state.setupPending),
  getAuthBootstrapState: vi.fn(async () => state.bootstrap),
  validateNewPassword: vi.fn(() => ({ ok: true })),
  clearLegacyGrace: vi.fn(async () => {}),
  LEGACY_GRACE_META_KEY: "legacyGrace",
  MIN_PASSWORD_LENGTH: 8,
}));

vi.mock("@/lib/auth/setupToken", () => ({
  issueSetupToken: () => "tok",
  printSetupBanner: () => {},
  consumeSetupToken: () => ({ ok: true }),
  getSetupTokenState: () => ({ present: true, expired: false, expiresInSec: 60 }),
  SETUP_WINDOW_MS: 1000,
}));
vi.mock("@/lib/auth/setupBootstrap", () => ({ ensureSetupToken: vi.fn() }));
vi.mock("@/lib/auth/loginLimiter", () => ({
  checkLock: () => ({ locked: false }),
  recordFail: () => ({ remainingBeforeLock: 4 }),
  recordSuccess: vi.fn(),
  getClientIp: () => "127.0.0.1",
  getClientKeys: () => ["127.0.0.1"],
}));

// Only the auth_token cookie is ever read: a route reading another name gets nothing.
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name) => (name === "auth_token" && state.cookies.auth_token ? { value: state.cookies.auth_token } : undefined),
    delete: (name) => {
      delete state.cookies[name];
    },
    set: (name, value) => {
      state.cookies[name] = value;
    },
  }),
}));

const PLACEHOLDER = "change-me-to-a-long-random-secret";

async function forge(secret, claims = {}) {
  return new SignJWT({ authenticated: true, ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(secret));
}

async function loadSession(jwtSecret) {
  vi.resetModules();
  if (jwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = jwtSecret;
  return await import("../../src/lib/auth/dashboardSession.js");
}

const jsonRequest = (body) =>
  new Request("http://localhost/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function resetState() {
  state.settings = {};
  state.meta = new Map();
  state.cookies = {};
  state.setupPending = false;
  state.bootstrap = "claimed";
  state.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "10r-jwt-"));
}

describe("dashboard JWT secret", () => {
  const originalSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    resetState();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
    vi.restoreAllMocks();
  });

  it("ignores the .env.example placeholder, so a token forged with it is rejected", async () => {
    const session = await loadSession(PLACEHOLDER);
    expect(await session.verifyDashboardAuthToken(await forge(PLACEHOLDER))).toBe(false);
    expect(console.warn).toHaveBeenCalled();
    expect(fs.readFileSync(path.join(state.dataDir, "jwt-secret"), "utf8")).toMatch(/^[0-9a-f]{64}$/);
    const own = await session.createDashboardAuthToken();
    expect(await session.verifyDashboardAuthToken(own)).toBe(true);
  });

  it("ignores the old built-in default secret", async () => {
    const legacy = "9router-default-secret-change-me";
    const session = await loadSession(legacy);
    expect(await session.verifyDashboardAuthToken(await forge(legacy))).toBe(false);
  });

  it("ignores secrets shorter than 32 characters", async () => {
    const session = await loadSession("short-but-not-a-placeholder");
    expect(await session.verifyDashboardAuthToken(await forge("short-but-not-a-placeholder"))).toBe(false);
  });

  it("uses a strong JWT_SECRET so instances can share sessions", async () => {
    const strong = "a".repeat(16) + "b".repeat(16) + "c".repeat(8);
    const session = await loadSession(strong);
    expect(await session.verifyDashboardAuthToken(await forge(strong))).toBe(true);
    expect(console.warn).not.toHaveBeenCalled();
  });
});

describe("dashboard session revocation", () => {
  beforeEach(() => {
    resetState();
  });

  it("keeps sessions issued before the epoch existed valid until the first revocation", async () => {
    const session = await loadSession(undefined);
    const token = await session.createDashboardAuthToken();
    expect(await session.getDashboardAuthSession(token)).toBeTruthy();

    await session.revokeDashboardSessions();
    expect(await session.getDashboardAuthSession(token)).toBeNull();

    const fresh = await session.createDashboardAuthToken();
    expect(await session.verifyDashboardAuthToken(fresh)).toBe(true);
  });

  it("keeps the epoch in _meta, not in settings", async () => {
    const session = await loadSession(undefined);
    await session.revokeDashboardSessions();
    expect(state.settings).toEqual({});
    expect([...state.meta.values()][0]).toMatch(/^[0-9a-f]{32}$/);
  });

  it("logout with a live session signs out every other browser too", async () => {
    const session = await loadSession(undefined);
    const other = await session.createDashboardAuthToken();
    state.cookies.auth_token = await session.createDashboardAuthToken();
    const { POST } = await import("../../src/app/api/auth/logout/route.js");
    await POST();
    expect(state.cookies.auth_token).toBeUndefined();
    expect(await session.getDashboardAuthSession(other)).toBeNull();
  });

  it.each([
    ["an anonymous caller", async () => "not-a-token"],
    ["a restricted password-change session", async (s) => s.createDashboardAuthToken({ pwChange: true })],
  ])("logout by %s only clears its own cookie", async (_label, makeCookie) => {
    const session = await loadSession(undefined);
    const other = await session.createDashboardAuthToken();
    state.cookies.auth_token = await makeCookie(session);
    const { POST } = await import("../../src/app/api/auth/logout/route.js");
    await POST();
    expect(state.cookies.auth_token).toBeUndefined();
    expect(await session.getDashboardAuthSession(other)).toBeTruthy();
  });

  it("logout by a pre-reset password session while setup is pending only clears its own cookie", async () => {
    const session = await loadSession(undefined);
    const other = await session.createDashboardAuthToken();
    state.cookies.auth_token = await session.createDashboardAuthToken();
    state.setupPending = true;
    const { POST } = await import("../../src/app/api/auth/logout/route.js");
    await POST();
    expect(await session.getDashboardAuthSession(other)).toBeTruthy();
  });

  it("password reset revokes existing sessions", async () => {
    const session = await loadSession(undefined);
    const token = await session.createDashboardAuthToken();
    const { POST } = await import("../../src/app/api/auth/reset-password/route.js");
    await POST();
    expect(state.settings.password).toBeNull();
    expect(await session.getDashboardAuthSession(token)).toBeNull();
  });

  it("change-password revokes the old sessions, then gives the caller a session that works", async () => {
    const session = await loadSession(undefined);
    const other = await session.createDashboardAuthToken();
    state.cookies.auth_token = await session.createDashboardAuthToken({ pwChange: true });
    state.bootstrap = "legacy";
    const { POST } = await import("../../src/app/api/auth/change-password/route.js");
    const res = await POST(jsonRequest({ newPassword: "a-new-password-1" }));
    expect(res.status).toBe(200);
    expect(await session.getDashboardAuthSession(other)).toBeNull();
    const fresh = await session.getDashboardAuthSession(state.cookies.auth_token);
    expect(fresh).toBeTruthy();
    expect(fresh.pwChange).toBeUndefined();
  });

  it("setup revokes the old sessions, then gives the caller a session that works", async () => {
    const session = await loadSession(undefined);
    const other = await session.createDashboardAuthToken();
    state.bootstrap = "setup";
    const { POST } = await import("../../src/app/api/auth/setup/route.js");
    const res = await POST(jsonRequest({ token: "tok", password: "a-new-password-1" }));
    expect(res.status).toBe(200);
    expect(await session.getDashboardAuthSession(other)).toBeNull();
    expect(await session.getDashboardAuthSession(state.cookies.auth_token)).toBeTruthy();
  });

  it("reissueDashboardSession keeps the SSO identity and drops bookkeeping and pwChange", async () => {
    const session = await loadSession(undefined);
    const token = await session.createDashboardAuthToken({ oidc: true, oidcSub: "sub-1", pwChange: true });
    const before = await session.getDashboardAuthSession(token);
    await session.revokeDashboardSessions();
    const store = { set: (name, value) => (state.cookies[name] = value) };
    await session.reissueDashboardSession(store, null, before);
    const after = await session.getDashboardAuthSession(state.cookies.auth_token);
    expect(after).toEqual(expect.objectContaining({ oidc: true, oidcSub: "sub-1" }));
    expect(after.pwChange).toBeUndefined();
    expect(after.sep).toBe([...state.meta.values()][0]);
  });
});
