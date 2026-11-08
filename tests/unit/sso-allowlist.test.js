import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setDashboardAuthCookie: vi.fn(),
  validateSamlResponse: vi.fn(),
  verifyOidcIdToken: vi.fn(),
  cookieValues: {},
}));
vi.mock("next/server", () => ({ NextResponse: { redirect: (value) => ({ redirect: String(value) }) } }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name) => (name in mocks.cookieValues ? { value: mocks.cookieValues[name] } : undefined), delete: vi.fn() }),
}));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({ authMode: "sso", ssoType: "saml" }) }));
vi.mock("@/lib/auth/dashboardSession", () => ({ setDashboardAuthCookie: mocks.setDashboardAuthCookie }));
vi.mock("@/lib/auth/loginLimiter", () => ({
  checkLock: () => ({ locked: false }), recordFail: vi.fn(), recordSuccess: vi.fn(), getClientIp: () => "127.0.0.1",
}));
vi.mock("@/lib/auth/saml.js", () => ({
  getSamlBaseUrl: () => "https://dash.example.test",
  isSamlConfigured: () => true,
  pickSamlEmail: (profile) => profile.email,
  pickSamlDisplayName: () => "User",
  validateSamlResponse: mocks.validateSamlResponse,
}));
vi.mock("@/lib/auth/oidc", () => ({
  getOidcRuntimeConfig: async () => ({ issuerUrl: "https://idp.example.test", clientId: "client" }),
  fetchOidcDiscovery: async () => ({ issuer: "https://idp.example.test", token_endpoint: "t", jwks_uri: "j" }),
  exchangeOidcCode: async () => ({ id_token: "id" }),
  getPublicOrigin: () => "https://dash.example.test",
  pickOidcEmail: (payload) => payload.email || "",
  pickOidcDisplayName: () => "User",
  verifyOidcIdToken: mocks.verifyOidcIdToken,
}));

const { isSsoPrincipalAllowed } = await import("../../src/lib/auth/ssoAllowlist.js");
const { POST: samlAcs } = await import("../../src/app/api/auth/saml/acs/route.js");
const { GET: oidcCallback } = await import("../../src/app/api/auth/oidc/callback/route.js");

describe("isSsoPrincipalAllowed", () => {
  it("allows everyone when no allowlist is set", () => {
    expect(isSsoPrincipalAllowed({ email: "anyone@example.test" }, undefined)).toBe(true);
    expect(isSsoPrincipalAllowed({ email: "anyone@example.test" }, " , ")).toBe(true);
  });

  it("matches emails case-insensitively, @domain suffixes, and exact subjects", () => {
    const list = "Owner@Example.test, @team.example.test, sub-123";
    expect(isSsoPrincipalAllowed({ email: "owner@example.test" }, list)).toBe(true);
    expect(isSsoPrincipalAllowed({ email: "dev@team.example.test" }, list)).toBe(true);
    expect(isSsoPrincipalAllowed({ subject: "sub-123" }, list)).toBe(true);
    expect(isSsoPrincipalAllowed({ email: "mallory@example.test", subject: "sub-999" }, list)).toBe(false);
    expect(isSsoPrincipalAllowed({ email: "x@evilteam.example.test" }, list)).toBe(false);
    expect(isSsoPrincipalAllowed({ subject: "SUB-123" }, list)).toBe(false);
  });

  it("ignores an email the IdP marks unverified", () => {
    expect(isSsoPrincipalAllowed({ email: "owner@example.test", emailVerified: false }, "owner@example.test")).toBe(false);
  });
});

describe("SSO callbacks enforce SSO_ALLOWED_USERS", () => {
  beforeEach(() => {
    vi.stubEnv("SSO_ALLOWED_USERS", "owner@example.test");
    mocks.cookieValues = { saml_state: "req", oidc_state: "st", oidc_nonce: "n", oidc_code_verifier: "v" };
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  function acsRequest() {
    const body = new URLSearchParams({ SAMLResponse: "x" });
    return new Request("https://dash.example.test/api/auth/saml/acs", { method: "POST", body });
  }

  it("refuses a SAML principal outside the allowlist", async () => {
    mocks.validateSamlResponse.mockResolvedValue({ nameID: "mallory", email: "mallory@example.test" });
    expect(await samlAcs(acsRequest())).toEqual({ redirect: "https://dash.example.test/login?error=sso_user_not_allowed" });
    expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();
  });

  it("signs in an allowlisted SAML principal", async () => {
    mocks.validateSamlResponse.mockResolvedValue({ nameID: "owner", email: "owner@example.test" });
    expect(await samlAcs(acsRequest())).toEqual({ redirect: "https://dash.example.test/dashboard" });
    expect(mocks.setDashboardAuthCookie).toHaveBeenCalledOnce();
  });

  it("refuses an OIDC principal outside the allowlist", async () => {
    mocks.verifyOidcIdToken.mockResolvedValue({ sub: "s", email: "mallory@example.test", email_verified: true });
    const res = await oidcCallback(new Request("https://dash.example.test/api/auth/oidc/callback?code=c&state=st"));
    expect(res).toEqual({ redirect: "https://dash.example.test/login?error=sso_user_not_allowed" });
    expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();
  });

  it("signs in an allowlisted OIDC principal", async () => {
    mocks.verifyOidcIdToken.mockResolvedValue({ sub: "s", email: "owner@example.test", email_verified: true });
    const res = await oidcCallback(new Request("https://dash.example.test/api/auth/oidc/callback?code=c&state=st"));
    expect(res).toEqual({ redirect: "https://dash.example.test/dashboard" });
    expect(mocks.setDashboardAuthCookie).toHaveBeenCalledOnce();
  });
});
