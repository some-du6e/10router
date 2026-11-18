import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  json: vi.fn((body, init) => ({
    status: init?.status || 200,
    body,
  })),
  cookies: vi.fn(),
  getSettings: vi.fn(),
  isOidcConfigured: vi.fn(),
  getDashboardAuthSession: vi.fn(),
  getMeta: vi.fn(),
}));

// The bootstrap state reads the legacy-grace flag from _meta.
vi.mock("@/lib/db/helpers/metaStore.js", () => ({
  getMeta: mocks.getMeta,
  setMeta: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: mocks.json },
}));

vi.mock("next/headers", () => ({
  cookies: mocks.cookies,
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
}));

vi.mock("@/lib/auth/oidc", () => ({
  isOidcConfigured: mocks.isOidcConfigured,
}));

vi.mock("@/lib/auth/dashboardSession", () => ({
  getDashboardAuthSession: mocks.getDashboardAuthSession,
}));

const { GET } = await import("../../src/app/api/auth/status/route.js");

describe("GET /api/auth/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireLogin: true, authMode: "password" });
    mocks.cookies.mockResolvedValue({ get: vi.fn(() => ({ value: "session-token" })) });
    mocks.isOidcConfigured.mockReturnValue(false);
    mocks.getMeta.mockResolvedValue("0");
  });

  it("offers SSO sign-in while setup is pending after a reset with a configured SSO", async () => {
    mocks.getSettings.mockResolvedValue({
      requireLogin: true,
      authMode: "both",
      ssoType: "oidc",
      oidcIssuerUrl: "https://idp.example.test",
      oidcClientId: "client",
      oidcClientSecret: "secret",
    });
    mocks.getDashboardAuthSession.mockResolvedValue(null);

    const response = await GET();

    expect(response.body.needsSetup).toBe(true);
    expect(response.body.ssoLoginAvailable).toBe(true);
  });

  it("offers no SSO sign-in when the selected SSO isn't configured", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: true, authMode: "both", ssoType: "saml" });
    mocks.getDashboardAuthSession.mockResolvedValue(null);

    const response = await GET();

    expect(response.body.needsSetup).toBe(true);
    expect(response.body.ssoLoginAvailable).toBe(false);
  });

  it("offers no SSO sign-in when status can't be read", async () => {
    mocks.getSettings.mockRejectedValue(new Error("database unavailable"));

    const response = await GET();

    expect(response.body.ssoLoginAvailable).toBe(false);
    expect(response.body.needsSetup).toBe(false);
  });

  it("reports an authenticated session when the auth cookie is valid", async () => {
    mocks.getDashboardAuthSession.mockResolvedValue({ authenticated: true });

    const response = await GET();

    expect(response.body.authenticated).toBe(true);
    expect(mocks.getDashboardAuthSession).toHaveBeenCalledWith("session-token");
  });

  it("reports unauthenticated when the auth cookie is invalid", async () => {
    mocks.getDashboardAuthSession.mockResolvedValue(null);

    const response = await GET();

    expect(response.body.authenticated).toBe(false);
  });

  it("fails closed when status dependencies throw", async () => {
    mocks.getSettings.mockRejectedValue(new Error("database unavailable"));

    const response = await GET();

    expect(response.body.authenticated).toBe(false);
    expect(response.body.requireLogin).toBe(true);
  });
});
