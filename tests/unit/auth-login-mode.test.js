import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getMeta: vi.fn(),
  setMeta: vi.fn(),
  setDashboardAuthCookie: vi.fn(),
  revokeDashboardSessions: vi.fn(),
  issueSetupToken: vi.fn(() => "setup-token"),
}));
vi.mock("next/server", () => ({
  NextResponse: { json: (body, init = {}) => ({ body, status: init.status ?? 200 }) },
}));
vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings, updateSettings: mocks.updateSettings }));
vi.mock("@/lib/db/helpers/metaStore.js", () => ({ getMeta: mocks.getMeta, setMeta: mocks.setMeta }));
vi.mock("@/lib/auth/dashboardSession", () => ({
  setDashboardAuthCookie: mocks.setDashboardAuthCookie,
  revokeDashboardSessions: mocks.revokeDashboardSessions,
}));
vi.mock("@/lib/auth/loginLimiter", () => ({
  checkLock: () => ({ locked: false }),
  reserveAttempt: () => ({ ok: true }),
  releaseAttempt: vi.fn(),
  recordFail: () => ({ remainingBeforeLock: 4 }),
  recordSuccess: vi.fn(),
  getClientIp: () => "127.0.0.1",
}));
vi.mock("@/lib/auth/setupToken", () => ({
  issueSetupToken: mocks.issueSetupToken,
  printSetupBanner: vi.fn(),
  SETUP_WINDOW_MS: 15 * 60 * 1000,
}));

const { getConfiguredSsoType } = await import("../../src/lib/auth/authMode.js");
const { POST: login } = await import("../../src/app/api/auth/login/route.js");
const { POST: resetPassword } = await import("../../src/app/api/auth/reset-password/route.js");

const oidc = { oidcIssuerUrl: "https://idp.example.com", oidcClientId: "client", oidcClientSecret: "secret" };
const saml = { samlEntryPoint: "https://idp.example.com/saml", samlCert: "cert" };

function attempt(password = "a-strong-bootstrap-pw") {
  return login(new Request("http://localhost:20128/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("INITIAL_PASSWORD", "");
  mocks.getMeta.mockResolvedValue("0");
});
afterEach(() => vi.unstubAllEnvs());

describe("password login under SSO modes", () => {
  it.each([
    ["legacy saml mode", { authMode: "saml" }, "SAML"],
    ["legacy oidc mode with a stale SAML selector", { authMode: "oidc", ssoType: "saml" }, "OIDC"],
    ["SAML only", { authMode: "sso", ssoType: "saml" }, "SAML"],
    ["SSO only with no selector", { authMode: "sso" }, "OIDC"],
  ])("refuses a password in %s and names the active protocol", async (_label, mode, protocol) => {
    mocks.getSettings.mockResolvedValue({ ...oidc, ...saml, ...mode });
    const res = await attempt();
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(protocol === "SAML"
      ? "Password login is disabled. Use SAML SSO sign in."
      : "Password login is disabled. Use OIDC sign in.");
  });

  it("accepts INITIAL_PASSWORD in both mode", async () => {
    vi.stubEnv("INITIAL_PASSWORD", "a-strong-bootstrap-pw");
    mocks.getSettings.mockResolvedValue({ ...oidc, authMode: "both", ssoType: "oidc" });
    const res = await attempt("a-strong-bootstrap-pw");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mocks.setDashboardAuthCookie).toHaveBeenCalledOnce();
  });

  it("sends both mode back to first-run setup after Reset Password", async () => {
    const settings = { ...oidc, authMode: "both", ssoType: "oidc", password: "$2a$10$stored-hash" };
    mocks.updateSettings.mockImplementation(async (patch) => Object.assign(settings, patch));
    mocks.getSettings.mockImplementation(async () => settings);

    const reset = await resetPassword();
    expect(reset.body).toEqual(expect.objectContaining({ success: true, token: "setup-token" }));
    expect(settings.password).toBeNull();
    // Sessions signed in before the reset end with it.
    expect(mocks.revokeDashboardSessions).toHaveBeenCalled();

    const res = await attempt("anything-at-all");
    expect(res.status).toBe(403);
    expect(res.body.needsSetup).toBe(true);
    expect(settings.authMode).toBe("both");
  });

  it.each([
    ["OIDC only", { authMode: "sso", ssoType: "oidc" }, "oidc"],
    ["SAML only", { authMode: "sso", ssoType: "saml" }, "saml"],
    ["legacy oidc mode with a stale SAML selector", { authMode: "oidc", ssoType: "saml" }, "oidc"],
  ])("turns password login back on when Reset Password runs in %s, keeping the same SSO", async (_label, mode, ssoType) => {
    const settings = { ...oidc, ...saml, ...mode, password: "$2a$10$stored-hash" };
    mocks.updateSettings.mockImplementation(async (patch) => Object.assign(settings, patch));
    mocks.getSettings.mockImplementation(async () => settings);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const reset = await resetPassword();
    expect(reset.body).toEqual(expect.objectContaining({ success: true, token: "setup-token" }));
    expect(settings).toEqual(expect.objectContaining({ password: null, authMode: "both", ssoType }));
    expect(getConfiguredSsoType(settings)).toBe(ssoType);
    expect(log.mock.calls.flat().join("\n")).toMatch(/Login mode switched/);
    expect(reset.body.message).toMatch(/sign-in keeps working/);

    // The printed token is usable: the instance is back in first-run setup.
    const res = await attempt("anything-at-all");
    expect(res.status).toBe(403);
    expect(res.body.needsSetup).toBe(true);
    log.mockRestore();
  });

  // With INITIAL_PASSWORD set no setup token is printed, and the mode is never switched.
  it.each([
    ["password", { authMode: "password" }, { status: 200 }],
    ["Both", { authMode: "both", ssoType: "oidc" }, { status: 200 }],
    ["OIDC only", { authMode: "sso", ssoType: "oidc" }, { status: 403, error: "Password login is disabled. Use OIDC sign in." }],
    ["SAML only", { authMode: "sso", ssoType: "saml" }, { status: 403, error: "Password login is disabled. Use SAML SSO sign in." }],
    ["legacy oidc", { authMode: "oidc" }, { status: 403, error: "Password login is disabled. Use OIDC sign in." }],
  ])("with INITIAL_PASSWORD set, Reset Password in %s says what happens and prints no token", async (_label, mode, login) => {
    vi.stubEnv("INITIAL_PASSWORD", "a-strong-bootstrap-pw");
    const settings = { ...oidc, ...saml, ...mode, password: "$2a$10$stored-hash" };
    const before = { ...settings };
    mocks.updateSettings.mockImplementation(async (patch) => Object.assign(settings, patch));
    mocks.getSettings.mockImplementation(async () => settings);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const reset = await resetPassword();
    expect(reset.body).toEqual(expect.objectContaining({ success: true, token: null }));
    expect(mocks.issueSetupToken).not.toHaveBeenCalled();
    expect(settings).toEqual({ ...before, password: null });
    if (login.status === 200) {
      expect(reset.body.message).toMatch(/INITIAL_PASSWORD is set: password login uses it/);
    } else {
      // INITIAL_PASSWORD doesn't quietly become a live login.
      expect(reset.body.message).toMatch(/Login mode is unchanged/);
      expect(reset.body.message).toMatch(/Reset Auth Mode/);
    }

    const res = await attempt("a-strong-bootstrap-pw");
    expect(res.status).toBe(login.status);
    if (login.error) expect(res.body.error).toBe(login.error);
    log.mockRestore();
  });

  it("says SSO keeps working when Reset Password runs in Both mode with a configured SSO", async () => {
    const settings = { ...oidc, authMode: "both", ssoType: "oidc", password: "$2a$10$stored-hash" };
    mocks.updateSettings.mockImplementation(async (patch) => Object.assign(settings, patch));
    mocks.getSettings.mockImplementation(async () => settings);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const reset = await resetPassword();
    expect(reset.body).toEqual(expect.objectContaining({ success: true, token: "setup-token" }));
    expect(reset.body.message).toMatch(/OIDC sign-in keeps working/);
    expect(settings.authMode).toBe("both");
    log.mockRestore();
  });
});
