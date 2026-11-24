import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  json: vi.fn((body, init) => ({ status: init?.status || 200, body })),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  verifyDashboardPassword: vi.fn(),
  getDashboardAuthSession: vi.fn(),
  revokeDashboardSessions: vi.fn(),
  reissueDashboardSession: vi.fn(),
  cookieGet: vi.fn(),
  applyOutboundProxyEnv: vi.fn(),
  resetComboRotation: vi.fn(),
  clearLegacyGrace: vi.fn(),
  clearSetupToken: vi.fn(),
  getAuthBootstrapState: vi.fn(),
  getBootstrapSecret: vi.fn(),
  validateNewPassword: vi.fn(),
  getProxyPoolById: vi.fn(async (id) => (id === "eu" ? { id: "eu" } : null)),
  clearRequestDetailFullData: vi.fn(async () => {}),
}));

vi.mock("@/lib/db/index.js", () => ({
  getProxyPoolById: mocks.getProxyPoolById,
  clearRequestDetailFullData: mocks.clearRequestDetailFullData,
}));

vi.mock("next/server", () => ({
  NextResponse: { json: mocks.json },
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  updateSettings: mocks.updateSettings,
}));

vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardPassword: mocks.verifyDashboardPassword,
  getDashboardAuthSession: mocks.getDashboardAuthSession,
  revokeDashboardSessions: mocks.revokeDashboardSessions,
  reissueDashboardSession: mocks.reissueDashboardSession,
}));

vi.mock("next/headers", () => ({
  // Only the auth_token cookie exists.
  cookies: async () => ({ get: (name) => (name === "auth_token" ? mocks.cookieGet(name) : undefined) }),
}));

vi.mock("@/lib/network/outboundProxy", () => ({
  applyOutboundProxyEnv: mocks.applyOutboundProxyEnv,
}));

vi.mock("open-sse/services/combo.js", () => ({
  resetComboRotation: mocks.resetComboRotation,
}));

vi.mock("@/lib/auth/setupState", () => ({
  getAuthBootstrapState: mocks.getAuthBootstrapState,
  getBootstrapSecret: mocks.getBootstrapSecret,
  validateNewPassword: mocks.validateNewPassword,
  clearLegacyGrace: mocks.clearLegacyGrace,
}));

vi.mock("@/lib/auth/setupToken", () => ({
  clearSetupToken: mocks.clearSetupToken,
}));

const { GET, PATCH } = await import("../../src/app/api/settings/route.js");

function request(body) {
  return new Request("http://localhost/api/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/settings sensitive request details", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ showSensitiveRequestDetails: false });
    mocks.updateSettings.mockResolvedValue({ showSensitiveRequestDetails: true });
    mocks.verifyDashboardPassword.mockResolvedValue(false);
  });

  it("requires the dashboard password before enabling full details", async () => {
    const response = await PATCH(request({ showSensitiveRequestDetails: true }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("Current password required");
    expect(mocks.verifyDashboardPassword).toHaveBeenCalledWith(undefined);
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it("persists the setting after a valid password confirmation", async () => {
    mocks.verifyDashboardPassword.mockResolvedValue(true);

    const response = await PATCH(request({
      showSensitiveRequestDetails: true,
      currentPassword: "correct password",
    }));

    expect(response.status).toBe(200);
    expect(mocks.verifyDashboardPassword).toHaveBeenCalledWith("correct password");
    expect(mocks.updateSettings).toHaveBeenCalledWith({ showSensitiveRequestDetails: true });
  });

  it("does not require a password when disabling full details", async () => {
    const response = await PATCH(request({ showSensitiveRequestDetails: false }));

    expect(response.status).toBe(200);
    expect(mocks.verifyDashboardPassword).not.toHaveBeenCalled();
    expect(mocks.updateSettings).toHaveBeenCalledWith({ showSensitiveRequestDetails: false });
  });

  it("redacts the usage hub key hash from settings reads and writes", async () => {
    const settings = { usageHubEnabled: true, usageHubKeyHash: "private-hash" };
    mocks.getSettings.mockResolvedValue(settings);
    mocks.updateSettings.mockResolvedValue(settings);
    expect((await GET()).body).not.toHaveProperty("usageHubKeyHash");
    expect((await PATCH(request({}))).body).not.toHaveProperty("usageHubKeyHash");
  });

  it("prevents hub key and toggle mass assignment through generic settings", async () => {
    await PATCH(request({ usageHubKeyHash: "attacker-hash", usageHubEnabled: true, theme: "dark" }));
    expect(mocks.updateSettings).toHaveBeenCalledWith({ theme: "dark" });
  });

  // The guard and the CLI tools page treat these URLs as this instance; only the
  // tunnel and Tailscale managers may write them.
  it.each([
    ["tailscaleUrl", "https://evil.example"],
    ["tailscaleEnabled", true],
    ["tunnelUrl", "https://evil.example"],
    ["tunnelEnabled", true],
    ["tunnelProvider", "cloudflare"],
  ])("refuses %s and writes nothing", async (key, value) => {
    const response = await PATCH(request({ [key]: value, theme: "dark" }));
    expect(response.status).toBe(400);
    expect(response.body.error).toContain(key);
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/settings session revocation", () => {
  let revoked;
  const callerSession = { authenticated: true, oidc: true, oidcSub: "sub-1", sep: "old-epoch", iat: 1, exp: 2 };

  beforeEach(async () => {
    vi.clearAllMocks();
    const { default: bcrypt } = await import("bcryptjs");
    mocks.getSettings.mockResolvedValue({ password: bcrypt.hashSync("old-password", 4) });
    mocks.updateSettings.mockImplementation(async (body) => body);
    mocks.getAuthBootstrapState.mockResolvedValue("claimed");
    mocks.validateNewPassword.mockReturnValue({ ok: true });
    // Like the real store: a revocation invalidates the caller's cookie too.
    revoked = false;
    mocks.getDashboardAuthSession.mockImplementation(async (token) => (token === "caller-token" && !revoked ? callerSession : null));
    mocks.revokeDashboardSessions.mockImplementation(async () => {
      revoked = true;
    });
  });

  const changePassword = () => PATCH(request({ currentPassword: "old-password", newPassword: "new-password-1" }));

  it("reads the caller's session before revoking, then reissues it", async () => {
    mocks.cookieGet.mockReturnValue({ value: "caller-token" });

    const response = await changePassword();

    expect(response.status).toBe(200);
    expect(mocks.revokeDashboardSessions).toHaveBeenCalledTimes(1);
    // Read after the revocation it would be null, and the caller would be signed out.
    expect(mocks.reissueDashboardSession).toHaveBeenCalledWith(expect.anything(), expect.anything(), callerSession);
    expect(mocks.revokeDashboardSessions.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.reissueDashboardSession.mock.invocationCallOrder[0]);
  });

  it("revokes for a caller with no cookie and has no session to reissue", async () => {
    mocks.cookieGet.mockReturnValue(undefined);

    const response = await changePassword();

    expect(response.status).toBe(200);
    expect(mocks.revokeDashboardSessions).toHaveBeenCalledTimes(1);
    expect(mocks.reissueDashboardSession).toHaveBeenCalledWith(expect.anything(), expect.anything(), null);
  });

  it("does not revoke anything when the password doesn't change", async () => {
    mocks.cookieGet.mockReturnValue({ value: "caller-token" });
    await PATCH(request({ theme: "dark" }));
    expect(mocks.revokeDashboardSessions).not.toHaveBeenCalled();
    expect(mocks.reissueDashboardSession).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/settings proxy layers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ providerStrategies: { claude: { proxyPoolId: "gone", fallbackStrategy: "round-robin" } } });
    mocks.updateSettings.mockImplementation(async (body) => body);
  });

  it("refuses a provider layer changed to a pool that doesn't exist", async () => {
    const response = await PATCH(request({ providerStrategies: { codex: { proxyPoolId: "missing" } } }));
    expect(response.status).toBe(400);
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it("lets an unchanged stale entry through, so other pages can save the whole map", async () => {
    const response = await PATCH(request({ providerStrategies: { claude: { proxyPoolId: "gone", fallbackStrategy: "fill-first" }, codex: { proxyPoolId: " eu " } } }));
    expect(response.status).toBe(200);
    expect(mocks.updateSettings).toHaveBeenCalledWith({
      providerStrategies: { claude: { proxyPoolId: "gone", fallbackStrategy: "fill-first" }, codex: { proxyPoolId: "eu" } },
    });
  });

  it("stores Inherit as no value and accepts Direct", async () => {
    await PATCH(request({ providerStrategies: { codex: { proxyPoolId: "__none__" }, github: { proxyPoolId: "__direct__" } } }));
    expect(mocks.updateSettings).toHaveBeenCalledWith({ providerStrategies: { codex: {}, github: { proxyPoolId: "__direct__" } } });
  });

  it("checks the Global layer the same way", async () => {
    expect((await PATCH(request({ globalProxyPoolId: "missing" }))).status).toBe(400);
    await PATCH(request({ globalProxyPoolId: "__none__" }));
    expect(mocks.updateSettings).toHaveBeenLastCalledWith({ globalProxyPoolId: null });
  });
});
