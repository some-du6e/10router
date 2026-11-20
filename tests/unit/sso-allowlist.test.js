import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setDashboardAuthCookie: vi.fn(),
  validateSamlResponse: vi.fn(),
  verifyOidcIdToken: vi.fn(),
  getSettings: vi.fn(),
  recordFail: vi.fn(),
  cookieValues: {},
}));
const SAML_SETTINGS = { authMode: "sso", ssoType: "saml", samlEntryPoint: "https://idp.example.test/sso", samlCert: "cert" };
vi.mock("next/server", () => ({ NextResponse: { redirect: (value) => ({ redirect: String(value) }) } }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name) => (name in mocks.cookieValues ? { value: mocks.cookieValues[name] } : undefined), delete: vi.fn() }),
}));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));
vi.mock("@/lib/auth/dashboardSession", () => ({ setDashboardAuthCookie: mocks.setDashboardAuthCookie }));
vi.mock("@/lib/auth/loginLimiter", () => ({
  checkLock: () => ({ locked: false }), recordFail: mocks.recordFail, recordSuccess: vi.fn(), getClientIp: () => "127.0.0.1", getClientKeys: () => ["127.0.0.1"],
}));
vi.mock("@/lib/auth/saml.js", () => ({
  getSamlBaseUrl: () => "https://dash.example.test",
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
    expect(isSsoPrincipalAllowed({ email: "owner@example.test", emailVerified: true }, list)).toBe(true);
    expect(isSsoPrincipalAllowed({ email: "dev@team.example.test", emailVerified: "true" }, list)).toBe(true);
    expect(isSsoPrincipalAllowed({ subject: "sub-123" }, list)).toBe(true);
    expect(isSsoPrincipalAllowed({ email: "mallory@example.test", subject: "sub-999", emailVerified: true }, list)).toBe(false);
    expect(isSsoPrincipalAllowed({ email: "x@evilteam.example.test", emailVerified: true }, list)).toBe(false);
    expect(isSsoPrincipalAllowed({ subject: "SUB-123" }, list)).toBe(false);
  });

  it("matches a subject entry by subject only, never by an email set to the same text", () => {
    expect(isSsoPrincipalAllowed({ subject: "sub-999", email: "sub-123", emailVerified: true }, "sub-123")).toBe(false);
  });

  it("ignores an email the IdP doesn't say it verified", () => {
    for (const emailVerified of [false, "false", undefined, null]) {
      expect(isSsoPrincipalAllowed({ email: "owner@example.test", emailVerified }, "owner@example.test"), String(emailVerified)).toBe(false);
      expect(isSsoPrincipalAllowed({ email: "dev@team.example.test", emailVerified }, "@team.example.test"), String(emailVerified)).toBe(false);
    }
  });
});

describe("SSO callbacks enforce SSO_ALLOWED_USERS", () => {
  beforeEach(() => {
    vi.stubEnv("SSO_ALLOWED_USERS", "owner@example.test");
    mocks.getSettings.mockResolvedValue(SAML_SETTINGS);
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

  it("refuses a SAML principal outside the allowlist without counting it toward the login lockout", async () => {
    mocks.validateSamlResponse.mockResolvedValue({ nameID: "mallory", email: "mallory@example.test" });
    expect(await samlAcs(acsRequest())).toEqual({ redirect: "https://dash.example.test/login?error=sso_user_not_allowed" });
    expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();
    // The IdP signed this user in; colleagues behind one NAT mustn't lock the admins out.
    expect(mocks.recordFail).not.toHaveBeenCalled();
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

  const oidcLogin = () => oidcCallback(new Request("https://dash.example.test/api/auth/oidc/callback?code=c&state=st"));

  it.each([["absent", undefined], ["false", false], ["\"false\"", "false"]])(
    "refuses an allowlisted OIDC email whose email_verified is %s",
    async (_label, emailVerified) => {
      mocks.verifyOidcIdToken.mockResolvedValue({ sub: "s", email: "owner@example.test", email_verified: emailVerified });
      expect(await oidcLogin()).toEqual({ redirect: "https://dash.example.test/login?error=sso_user_not_allowed" });
      expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();
    },
  );

  it("signs in an OIDC principal allowlisted by subject, with no verified email", async () => {
    vi.stubEnv("SSO_ALLOWED_USERS", "entra-object-id");
    mocks.verifyOidcIdToken.mockResolvedValue({ sub: "entra-object-id", email: "someone@example.test" });
    expect(await oidcLogin()).toEqual({ redirect: "https://dash.example.test/dashboard" });
    expect(mocks.setDashboardAuthCookie).toHaveBeenCalledOnce();
  });

  it("signs in a SAML principal allowlisted by NameID", async () => {
    vi.stubEnv("SSO_ALLOWED_USERS", "owner-name-id");
    mocks.validateSamlResponse.mockResolvedValue({ nameID: "owner-name-id", email: "someone@example.test" });
    expect(await samlAcs(acsRequest())).toEqual({ redirect: "https://dash.example.test/dashboard" });
  });

  it("refuses a SAML principal whose email, not NameID, is the allowlisted subject", async () => {
    vi.stubEnv("SSO_ALLOWED_USERS", "owner-name-id");
    mocks.validateSamlResponse.mockResolvedValue({ nameID: "mallory-name-id", email: "owner-name-id" });
    expect(await samlAcs(acsRequest())).toEqual({ redirect: "https://dash.example.test/login?error=sso_user_not_allowed" });
    expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();
  });
});

describe("SAML ACS only runs in SAML mode", () => {
  afterEach(() => vi.clearAllMocks());

  it.each([
    ["password", { authMode: "password", ssoType: "saml" }],
    ["OIDC only", { authMode: "sso", ssoType: "oidc" }],
    ["legacy oidc", { authMode: "oidc" }],
  ])("refuses a signed response with SAML settings saved but %s selected", async (_label, mode) => {
    mocks.getSettings.mockResolvedValue({ ...SAML_SETTINGS, ...mode });
    mocks.cookieValues = { saml_state: "req" };
    mocks.validateSamlResponse.mockResolvedValue({ nameID: "owner", email: "owner@example.test" });
    const res = await samlAcs(new Request("https://dash.example.test/api/auth/saml/acs", { method: "POST", body: new URLSearchParams({ SAMLResponse: "x" }) }));
    expect(res).toEqual({ redirect: "https://dash.example.test/login?error=saml_not_configured" });
    expect(mocks.validateSamlResponse).not.toHaveBeenCalled();
    expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();
  });
});
