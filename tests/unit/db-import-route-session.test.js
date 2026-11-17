import { beforeEach, describe, expect, it, vi } from "vitest";

const CALLER = { authenticated: true, oidc: true, oidcSub: "sub-1", sep: "old-epoch" };

const mocks = vi.hoisted(() => ({
  state: { revoked: false, cookie: undefined },
  importDb: vi.fn(),
  reissueDashboardSession: vi.fn(),
  verifyDashboardPassword: vi.fn(async (password) => password === "right-password"),
  isValidCliToken: vi.fn(async (token) => token === "cli-token"),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (body, init = {}) => ({ status: init.status || 200, body }) },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name) => (name === "auth_token" && mocks.state.cookie ? { value: mocks.state.cookie } : undefined),
  }),
}));
vi.mock("@/lib/localDb", () => ({
  exportDb: vi.fn(),
  importDb: mocks.importDb,
  getSettings: vi.fn(async () => ({})),
}));
vi.mock("@/lib/network/outboundProxy", () => ({ applyOutboundProxyEnv: vi.fn() }));
vi.mock("@/lib/auth/cliToken.js", () => ({ CLI_TOKEN_HEADER: "x-9r-cli-token", isValidCliToken: mocks.isValidCliToken }));
vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardPassword: mocks.verifyDashboardPassword,
  // Like the real store: once the import starts a new epoch, the cookie is dead.
  getDashboardAuthSession: vi.fn(async (token) => (token === "caller-token" && !mocks.state.revoked ? CALLER : null)),
  reissueDashboardSession: mocks.reissueDashboardSession,
}));

const { POST } = await import("../../src/app/api/settings/database/route.js");

const importRequest = (body, headers = {}) =>
  new Request("http://localhost/api/settings/database", { method: "POST", headers, body: JSON.stringify(body) });

describe("DB import and the caller's session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.importDb.mockReset();
    mocks.state.revoked = false;
    mocks.state.cookie = undefined;
  });

  it("an import that changes the password signs the caller back in with the session read before it", async () => {
    mocks.state.cookie = "caller-token";
    mocks.importDb.mockImplementation(async () => {
      mocks.state.revoked = true;
    });

    const res = await POST(importRequest({ password: "right-password", settings: {} }));

    expect(res.status).toBe(200);
    expect(mocks.reissueDashboardSession).toHaveBeenCalledWith(expect.anything(), expect.anything(), CALLER);
    expect(mocks.importDb.mock.invocationCallOrder[0]).toBeLessThan(mocks.reissueDashboardSession.mock.invocationCallOrder[0]);
  });

  it("an import that leaves the password alone reissues nothing", async () => {
    mocks.state.cookie = "caller-token";
    const res = await POST(importRequest({ password: "right-password", settings: {} }));
    expect(res.status).toBe(200);
    expect(mocks.reissueDashboardSession).not.toHaveBeenCalled();
  });

  it("a CLI-token import with no cookie reissues nothing", async () => {
    mocks.importDb.mockImplementation(async () => {
      mocks.state.revoked = true;
    });
    const res = await POST(importRequest({ settings: {} }, { "x-9r-cli-token": "cli-token" }));
    expect(res.status).toBe(200);
    expect(mocks.importDb).toHaveBeenCalled();
    expect(mocks.reissueDashboardSession).not.toHaveBeenCalled();
  });
});
