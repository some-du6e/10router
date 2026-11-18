import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getDashboardAuthSession: vi.fn(),
  getMeta: vi.fn(),
  token: "session",
}));
vi.mock("next/server", () => ({ NextResponse: { json: (body, init = {}) => ({ body, status: init.status ?? 200 }) } }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => (mocks.token ? { value: mocks.token } : undefined) }) }));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));
vi.mock("@/lib/db/helpers/metaStore.js", () => ({ getMeta: mocks.getMeta, setMeta: vi.fn() }));
vi.mock("@/lib/auth/dashboardSession", () => ({ getDashboardAuthSession: mocks.getDashboardAuthSession }));
vi.mock("@/lib/auth/saml.js", () => ({ formatX509Certificate: (cert) => (cert ? `PEM:${cert}` : "") }));

const { POST } = await import("../../src/app/api/auth/saml/test/route.js");

const saved = {
  requireLogin: true,
  password: "$2a$10$stored-hash",
  samlEntryPoint: "https://idp.example.test/sso",
  samlIssuer: "urn:9router:sp",
  samlCert: "stored-cert",
};
const post = (body = {}) => POST(new Request("https://dash.example.test/api/auth/saml/test", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("INITIAL_PASSWORD", "");
  mocks.token = "session";
  mocks.getMeta.mockResolvedValue("0");
  mocks.getSettings.mockResolvedValue(saved);
  mocks.getDashboardAuthSession.mockResolvedValue({ authenticated: true });
});

describe("SAML settings test route access", () => {
  it("checks the saved settings for a signed-in session on a claimed instance", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("refuses a forced-password-change session and anonymous callers", async () => {
    mocks.getDashboardAuthSession.mockResolvedValue({ authenticated: true, pwChange: true });
    expect((await post()).status).toBe(401);
    mocks.getDashboardAuthSession.mockResolvedValue(null);
    mocks.token = null;
    expect((await post()).status).toBe(401);
  });

  it("refuses a password session from before a reset, even with requireLogin off", async () => {
    // Setup pending: no stored hash, SAML configured in Both mode.
    mocks.getSettings.mockResolvedValue({ ...saved, password: undefined, requireLogin: false, authMode: "both", ssoType: "saml" });
    expect((await post()).status).toBe(401);

    mocks.getDashboardAuthSession.mockResolvedValue({ authenticated: true, saml: true });
    expect((await post()).status).toBe(200);
  });

  it("is open with requireLogin off once the instance is claimed", async () => {
    mocks.getSettings.mockResolvedValue({ ...saved, requireLogin: false });
    mocks.getDashboardAuthSession.mockResolvedValue(null);
    mocks.token = null;
    expect((await post()).status).toBe(200);
  });
});
