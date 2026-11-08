import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  json: vi.fn((body, init) => ({ status: init?.status || 200, body })),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  verifyDashboardPassword: vi.fn(),
  getDashboardAuthSession: vi.fn(),
  revokeDashboardSessions: vi.fn(),
  setDashboardAuthCookie: vi.fn(),
  cookieGet: vi.fn(),
  applyOutboundProxyEnv: vi.fn(),
  resetComboRotation: vi.fn(),
  clearLegacyGrace: vi.fn(),
  clearSetupToken: vi.fn(),
  getAuthBootstrapState: vi.fn(),
  getBootstrapSecret: vi.fn(),
  validateNewPassword: vi.fn(),
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
  setDashboardAuthCookie: mocks.setDashboardAuthCookie,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: mocks.cookieGet }),
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
});

describe("PATCH /api/settings session revocation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ password: "$2a$10$hash" });
    mocks.updateSettings.mockImplementation(async (body) => body);
    mocks.getAuthBootstrapState.mockResolvedValue("claimed");
    mocks.validateNewPassword.mockReturnValue({ ok: true });
  });

  it("revokes other sessions on a password change and reissues the caller's", async () => {
    const { default: bcrypt } = await import("bcryptjs");
    mocks.getSettings.mockResolvedValue({ password: bcrypt.hashSync("old-password", 4) });
    mocks.cookieGet.mockReturnValue({ value: "caller-token" });
    mocks.getDashboardAuthSession.mockResolvedValue({ authenticated: true });

    const response = await PATCH(request({ currentPassword: "old-password", newPassword: "new-password-1" }));

    expect(response.status).toBe(200);
    expect(mocks.revokeDashboardSessions).toHaveBeenCalledTimes(1);
    expect(mocks.setDashboardAuthCookie).toHaveBeenCalledTimes(1);
    expect(mocks.revokeDashboardSessions.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.setDashboardAuthCookie.mock.invocationCallOrder[0]);
  });

  it("does not let the body set the session epoch or leak it back", async () => {
    mocks.getSettings.mockResolvedValue({ sessionEpoch: "abc" });
    mocks.updateSettings.mockResolvedValue({ sessionEpoch: "abc", theme: "dark" });
    const response = await PATCH(request({ sessionEpoch: "attacker", theme: "dark" }));
    expect(mocks.updateSettings).toHaveBeenCalledWith({ theme: "dark" });
    expect(response.body).not.toHaveProperty("sessionEpoch");
    expect((await GET()).body).not.toHaveProperty("sessionEpoch");
  });
});
