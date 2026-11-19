import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getDashboardAuthSession: vi.fn(),
  getMeta: vi.fn(),
  fetchOidcDiscovery: vi.fn(),
  probeOidcClientSecret: vi.fn(),
  token: "session",
}));
vi.mock("next/server", () => ({ NextResponse: { json: (body, init = {}) => ({ body, status: init.status ?? 200 }) } }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => (mocks.token ? { value: mocks.token } : undefined) }) }));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));
vi.mock("@/lib/db/helpers/metaStore.js", () => ({ getMeta: mocks.getMeta, setMeta: vi.fn() }));
vi.mock("@/lib/auth/dashboardSession", () => ({ getDashboardAuthSession: mocks.getDashboardAuthSession }));
vi.mock("@/lib/auth/oidc", () => ({
  fetchOidcDiscovery: mocks.fetchOidcDiscovery,
  getPublicOrigin: () => "https://dash.example.test",
  probeOidcClientSecret: mocks.probeOidcClientSecret,
}));

const { POST } = await import("../../src/app/api/auth/oidc/test/route.js");

const saved = {
  requireLogin: true,
  password: "$2a$10$stored-hash",
  oidcIssuerUrl: "https://idp.example.test/",
  oidcClientId: "client",
  oidcClientSecret: "stored-secret",
};
const post = (body) => POST(new Request("https://dash.example.test/api/auth/oidc/test", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("INITIAL_PASSWORD", "");
  mocks.token = "session";
  mocks.getMeta.mockResolvedValue("0");
  mocks.getSettings.mockResolvedValue(saved);
  mocks.getDashboardAuthSession.mockResolvedValue({ authenticated: true });
  mocks.fetchOidcDiscovery.mockImplementation(async (issuer) => ({ token_endpoint: `${issuer.replace(/\/+$/, "")}/token` }));
  mocks.probeOidcClientSecret.mockResolvedValue({ tested: true, valid: true, message: "ok" });
});

describe("OIDC settings test route", () => {
  it("uses the saved client secret against the saved issuer", async () => {
    const res = await post({ issuerUrl: "https://idp.example.test" });
    expect(res.status).toBe(200);
    expect(mocks.probeOidcClientSecret).toHaveBeenCalledWith(expect.objectContaining({ clientSecret: "stored-secret", tokenEndpoint: "https://idp.example.test/token" }));
  });

  it("never sends the saved client secret to another issuer", async () => {
    const res = await post({ issuerUrl: "https://attacker.example.test" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Enter the client secret/);
    expect(mocks.fetchOidcDiscovery).not.toHaveBeenCalled();
    expect(mocks.probeOidcClientSecret).not.toHaveBeenCalled();
  });

  it("tests another issuer with the secret the request brings", async () => {
    const res = await post({ issuerUrl: "https://other-idp.example.test", clientSecret: "typed-secret" });
    expect(res.status).toBe(200);
    expect(mocks.probeOidcClientSecret).toHaveBeenCalledWith(expect.objectContaining({ clientSecret: "typed-secret" }));
  });

  it("refuses a forced-password-change session and anonymous callers", async () => {
    mocks.getDashboardAuthSession.mockResolvedValue({ authenticated: true, pwChange: true });
    expect((await post({})).status).toBe(401);
    mocks.getDashboardAuthSession.mockResolvedValue(null);
    mocks.token = null;
    expect((await post({})).status).toBe(401);
    expect(mocks.probeOidcClientSecret).not.toHaveBeenCalled();
  });

  it("refuses a password session from before a reset, even with requireLogin off", async () => {
    // Setup pending: no stored hash, OIDC configured in Both mode.
    mocks.getSettings.mockResolvedValue({ ...saved, password: undefined, requireLogin: false, authMode: "both", ssoType: "oidc" });
    expect((await post({})).status).toBe(401);

    mocks.getDashboardAuthSession.mockResolvedValue({ authenticated: true, oidc: true });
    expect((await post({})).status).toBe(200);
  });

  it("is open with requireLogin off once the instance is claimed", async () => {
    mocks.getSettings.mockResolvedValue({ ...saved, requireLogin: false });
    mocks.getDashboardAuthSession.mockResolvedValue(null);
    expect((await post({})).status).toBe(200);
  });
});
