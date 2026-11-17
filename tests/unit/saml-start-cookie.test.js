import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getSamlBaseUrl: vi.fn(),
  buildSamlAuthorizeUrl: vi.fn(),
  shouldUseSecureCookie: vi.fn(),
  set: vi.fn(),
}));
vi.mock("next/server", () => ({ NextResponse: { redirect: value => ({ redirect: String(value) }) } }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: mocks.set }) }));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));
vi.mock("@/lib/auth/saml.js", () => ({
  getSamlBaseUrl: mocks.getSamlBaseUrl,
  buildSamlAuthorizeUrl: mocks.buildSamlAuthorizeUrl,
}));
vi.mock("@/lib/auth/dashboardSession", () => ({ shouldUseSecureCookie: mocks.shouldUseSecureCookie }));

const { GET } = await import("../../src/app/api/auth/saml/start/route.js");

const samlSettings = { samlEntryPoint: "https://idp.example.com/sso", samlCert: "cert" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.getSettings.mockResolvedValue({ ...samlSettings, authMode: "sso", ssoType: "saml" });
  mocks.getSamlBaseUrl.mockReturnValue("https://dashboard.example.com");
  mocks.shouldUseSecureCookie.mockReturnValue(false);
  mocks.buildSamlAuthorizeUrl.mockResolvedValue({ authorizeUrl: "https://idp.example.com/saml", requestId: "request-123" });
});

describe("SAML authorization request cookie", () => {
  it("persists request binding through the cross-site HTTPS IdP POST", async () => {
    expect(await GET(new Request("https://dashboard.example.com/api/auth/saml/start"))).toEqual({ redirect: "https://idp.example.com/saml" });
    expect(mocks.set).toHaveBeenCalledWith("saml_state", "request-123", {
      httpOnly: true, secure: true, sameSite: "none", path: "/", maxAge: 600,
    });
  });

  it("retains secure cross-site cookies behind an HTTPS reverse proxy", async () => {
    mocks.getSamlBaseUrl.mockReturnValue("http://localhost:20128");
    mocks.shouldUseSecureCookie.mockReturnValue(true);
    await GET(new Request("http://localhost:20128/api/auth/saml/start"));
    expect(mocks.set).toHaveBeenCalledWith("saml_state", "request-123", expect.objectContaining({ secure: true, sameSite: "none" }));
  });

  it("does not attempt an insecure SameSite=None cookie on HTTP", async () => {
    mocks.getSamlBaseUrl.mockReturnValue("http://localhost:20128");
    await GET(new Request("http://localhost:20128/api/auth/saml/start"));
    expect(mocks.set).toHaveBeenCalledWith("saml_state", "request-123", expect.objectContaining({ secure: false, sameSite: "lax" }));
  });

  it.each([
    ["only password authentication is selected", { authMode: "password", ssoType: "saml" }],
    ["OIDC is the selected protocol", { authMode: "sso", ssoType: "oidc" }],
  ])("cannot start SAML when %s", async (_label, mode) => {
    mocks.getSettings.mockResolvedValue({ ...samlSettings, ...mode });
    const response = await GET(new Request("https://dashboard.example.com/api/auth/saml/start"));
    expect(response.redirect).toBe("https://dashboard.example.com/login?error=saml_not_configured");
    expect(mocks.buildSamlAuthorizeUrl).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("caps how often one client can start a SAML login", async () => {
    vi.stubEnv("TRUST_PROXY", "true");
    const start = (ip) => GET(new Request("https://dashboard.example.com/api/auth/saml/start", { headers: { "x-forwarded-for": ip } }));
    for (let i = 0; i < 20; i++) expect((await start("203.0.113.7")).redirect).toBe("https://idp.example.com/saml");
    expect((await start("203.0.113.7")).redirect).toBe("https://dashboard.example.com/login?error=saml_rate_limited");
    expect(mocks.buildSamlAuthorizeUrl).toHaveBeenCalledTimes(20);
    // Another client still gets through.
    expect((await start("203.0.113.8")).redirect).toBe("https://idp.example.com/saml");
  });
});
