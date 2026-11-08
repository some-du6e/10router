import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getSamlBaseUrl: vi.fn(),
  buildSamlAuthorizeUrl: vi.fn(),
  isSamlConfigured: vi.fn(),
  shouldUseSecureCookie: vi.fn(),
  set: vi.fn(),
}));
vi.mock("next/server", () => ({ NextResponse: { redirect: value => ({ redirect: String(value) }) } }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: mocks.set }) }));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));
vi.mock("@/lib/auth/saml.js", () => ({
  getSamlBaseUrl: mocks.getSamlBaseUrl,
  buildSamlAuthorizeUrl: mocks.buildSamlAuthorizeUrl,
  isSamlConfigured: mocks.isSamlConfigured,
}));
vi.mock("@/lib/auth/dashboardSession", () => ({ shouldUseSecureCookie: mocks.shouldUseSecureCookie }));

const { GET } = await import("../../src/app/api/auth/saml/start/route.js");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSettings.mockResolvedValue({ authMode: "sso", ssoType: "saml" });
  mocks.getSamlBaseUrl.mockReturnValue("https://dashboard.example.com");
  mocks.isSamlConfigured.mockReturnValue(true);
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

  it("cannot start SAML when only password authentication is selected", async () => {
    mocks.getSettings.mockResolvedValue({ authMode: "password", ssoType: "saml" });
    const response = await GET(new Request("https://dashboard.example.com/api/auth/saml/start"));
    expect(response.redirect).toBe("https://dashboard.example.com/login?error=saml_not_configured");
    expect(mocks.buildSamlAuthorizeUrl).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
  });
});
