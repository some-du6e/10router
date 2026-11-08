import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SignJWT } from "jose";

const state = vi.hoisted(() => ({ settings: {}, dataDir: "", cookie: undefined }));

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

vi.mock("@/lib/auth/setupState", () => ({ getBootstrapSecret: vi.fn(), LEGACY_GRACE_META_KEY: "legacyGrace" }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (state.cookie ? { value: state.cookie } : undefined),
    delete: vi.fn(),
    set: vi.fn(),
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

describe("dashboard JWT secret", () => {
  const originalSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    state.settings = {};
    state.cookie = undefined;
    state.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "10r-jwt-"));
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

  it("rejects every documented placeholder", async () => {
    const { isUsableJwtSecret } = await loadSession(undefined);
    for (const value of [
      PLACEHOLDER,
      "your-secure-secret",
      "your-secure-secret-change-this",
      "your-secure-secret-change-this-to-random-string",
      "generated-secret-here",
      "",
      undefined,
    ]) {
      expect(isUsableJwtSecret(value)).toBe(false);
    }
  });
});

describe("dashboard session revocation", () => {
  beforeEach(() => {
    state.settings = {};
    state.cookie = undefined;
    state.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "10r-jwt-"));
  });

  it("keeps sessions issued before the epoch existed valid until the first revocation", async () => {
    const session = await loadSession(undefined);
    const token = await session.createDashboardAuthToken();
    expect(await session.getDashboardAuthSession(token)).toBeTruthy();

    await session.revokeDashboardSessions();
    expect(await session.getDashboardAuthSession(token)).toBeNull();
    expect(await session.verifyDashboardAuthToken(token)).toBe(false);

    const fresh = await session.createDashboardAuthToken();
    expect(await session.verifyDashboardAuthToken(fresh)).toBe(true);
  });

  it("logout revokes the caller's stolen copy of the session", async () => {
    const session = await loadSession(undefined);
    const token = await session.createDashboardAuthToken();
    state.cookie = token;
    const { POST } = await import("../../src/app/api/auth/logout/route.js");
    await POST();
    expect(await session.getDashboardAuthSession(token)).toBeNull();
  });

  it("an anonymous logout does not revoke anyone", async () => {
    const session = await loadSession(undefined);
    const token = await session.createDashboardAuthToken();
    state.cookie = "not-a-token";
    const { POST } = await import("../../src/app/api/auth/logout/route.js");
    await POST();
    expect(await session.getDashboardAuthSession(token)).toBeTruthy();
  });

  it("password reset revokes existing sessions", async () => {
    const session = await loadSession(undefined);
    const token = await session.createDashboardAuthToken();
    vi.doMock("@/lib/db/helpers/metaStore.js", () => ({ setMeta: vi.fn(), getMeta: vi.fn() }));
    vi.doMock("@/lib/auth/setupToken", () => ({
      issueSetupToken: () => "tok",
      printSetupBanner: () => {},
      SETUP_WINDOW_MS: 1000,
    }));
    const { POST } = await import("../../src/app/api/auth/reset-password/route.js");
    await POST();
    expect(state.settings.password).toBeNull();
    expect(await session.getDashboardAuthSession(token)).toBeNull();
  });
});
