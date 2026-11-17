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
  SAML_REQUEST_TTL_MS: 10 * 60 * 1000,
}));
vi.mock("@/lib/auth/dashboardSession", () => ({ shouldUseSecureCookie: mocks.shouldUseSecureCookie }));

const { GET } = await import("../../src/app/api/auth/saml/start/route.js");

const samlSettings = { samlEntryPoint: "https://idp.example.com/sso", samlCert: "cert" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSettings.mockResolvedValue({ ...samlSettings, authMode: "sso", ssoType: "saml" });
  mocks.getSamlBaseUrl.mockReturnValue("https://dashboard.example.com");
  mocks.shouldUseSecureCookie.mockReturnValue(false);
  mocks.buildSamlAuthorizeUrl.mockResolvedValue({ authorizeUrl: "https://idp.example.com/saml", requestId: "request-123", stateCookie: "signed-state" });
});

describe("SAML authorization request cookie", () => {
  it("persists the signed request state through the cross-site HTTPS IdP POST, for the request's lifetime", async () => {
    expect(await GET(new Request("https://dashboard.example.com/api/auth/saml/start"))).toEqual({ redirect: "https://idp.example.com/saml" });
    expect(mocks.set).toHaveBeenCalledWith("saml_state", "signed-state", {
      httpOnly: true, secure: true, sameSite: "none", path: "/", maxAge: 600,
    });
  });

  it("retains secure cross-site cookies behind an HTTPS reverse proxy", async () => {
    mocks.getSamlBaseUrl.mockReturnValue("http://localhost:20128");
    mocks.shouldUseSecureCookie.mockReturnValue(true);
    await GET(new Request("http://localhost:20128/api/auth/saml/start"));
    expect(mocks.set).toHaveBeenCalledWith("saml_state", "signed-state", expect.objectContaining({ secure: true, sameSite: "none" }));
  });

  it("does not attempt an insecure SameSite=None cookie on HTTP", async () => {
    mocks.getSamlBaseUrl.mockReturnValue("http://localhost:20128");
    await GET(new Request("http://localhost:20128/api/auth/saml/start"));
    expect(mocks.set).toHaveBeenCalledWith("saml_state", "signed-state", expect.objectContaining({ secure: false, sameSite: "lax" }));
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

  it("starts every login, however many come from one client", async () => {
    for (let i = 0; i < 50; i++) expect((await GET(new Request("https://dashboard.example.com/api/auth/saml/start"))).redirect).toBe("https://idp.example.com/saml");
    expect(mocks.buildSamlAuthorizeUrl).toHaveBeenCalledTimes(50);
  });
});
