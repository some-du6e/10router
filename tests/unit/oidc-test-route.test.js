import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRIVATE_URL_ERROR } from "../../src/shared/constants/privateUrl.js";

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
// Who is calling: a local caller may test an issuer on a private host.
const caller = vi.hoisted(() => ({ local: true }));
vi.mock("@/dashboardGuard", () => ({ isLocalRequest: () => caller.local, hasSignedInDashboardSession: async () => false }));
vi.mock("@/lib/auth/oidc", async (orig) => ({
  ...(await orig()),
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
  caller.local = true;
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

  it("from a remote session, fetches the issuer and its token endpoint through the checked probe", async () => {
    const real = await vi.importActual("@/lib/auth/oidc");
    mocks.fetchOidcDiscovery.mockImplementation(real.fetchOidcDiscovery);
    mocks.probeOidcClientSecret.mockImplementation(real.probeOidcClientSecret);
    caller.local = false;
    const issuer = await post({ issuerUrl: "http://10.0.0.5", clientSecret: "typed-secret" });
    expect(issuer.status).toBe(400);
    expect(issuer.body.error).toBe(PRIVATE_URL_ERROR);

    // A public issuer whose discovery document names an internal token endpoint.
    mocks.fetchOidcDiscovery.mockResolvedValue({ token_endpoint: "http://169.254.169.254/token" });
    const token = await post({ issuerUrl: "https://203.0.113.20", clientSecret: "typed-secret" });
    expect(token.status).toBe(400);
    expect(token.body.error).toBe(PRIVATE_URL_ERROR);
  });

  it("a local caller tests with the plain fetch", async () => {
    await post({ issuerUrl: "https://idp.example.test" });
    expect(mocks.fetchOidcDiscovery).toHaveBeenCalledWith("https://idp.example.test", { fetchImpl: undefined });
  });
});
