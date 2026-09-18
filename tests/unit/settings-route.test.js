import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  json: vi.fn((body, init) => ({ status: init?.status || 200, body })),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  verifyDashboardPassword: vi.fn(),
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

const { PATCH } = await import("../../src/app/api/settings/route.js");

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
});
