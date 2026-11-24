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

// The outbound proxy URL gets the private-host rule: who is calling.
const caller = vi.hoisted(() => ({ local: true, session: false }));
vi.mock("@/dashboardGuard", () => ({
  isLocalRequest: () => caller.local,
  hasSignedInDashboardSession: async () => caller.session,
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

describe("PATCH /api/settings outbound proxy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    caller.local = false;
    caller.session = false;
    mocks.getSettings.mockResolvedValue({ outboundProxyEnabled: false, outboundProxyUrl: "" });
    mocks.updateSettings.mockImplementation(async (body) => body);
  });

  it("refuses a private proxy URL from a remote session, saved on or off", async () => {
    for (const body of [
      { outboundProxyEnabled: true, outboundProxyUrl: "http://10.0.0.8:3128" },
      { outboundProxyEnabled: false, outboundProxyUrl: "127.0.0.1:7890" },
    ]) {
      const res = await PATCH(request(body));
      expect(res.status).toBe(400);
      expect(res.body.field).toBe("outboundProxyUrl");
    }
    expect(mocks.updateSettings).not.toHaveBeenCalled();
    expect(mocks.applyOutboundProxyEnv).not.toHaveBeenCalled();
  });

  it("checks a stored private URL when a remote session switches it on", async () => {
    mocks.getSettings.mockResolvedValue({ outboundProxyEnabled: false, outboundProxyUrl: "http://10.0.0.8:3128" });
    expect((await PATCH(request({ outboundProxyEnabled: true }))).status).toBe(400);
  });

  it("reads the switch and the URL the way the proxy does: any truthy switch, any URL value", async () => {
    mocks.getSettings.mockResolvedValue({ outboundProxyEnabled: false, outboundProxyUrl: "http://10.0.0.8:3128" });
    expect((await PATCH(request({ outboundProxyEnabled: 1 }))).status).toBe(400);
    mocks.getSettings.mockResolvedValue({ outboundProxyEnabled: false, outboundProxyUrl: "" });
    const array = await PATCH(request({ outboundProxyEnabled: true, outboundProxyUrl: ["http://10.0.0.5:3128"] }));
    expect(array.status).toBe(400);
    expect(array.body).toEqual({ error: "outboundProxyUrl must be a string", field: "outboundProxyUrl" });
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it("lets a local session, or a signed-in one with ALLOW_PRIVATE_ENDPOINT_URLS, use a LAN proxy", async () => {
    caller.local = true;
    expect((await PATCH(request({ outboundProxyEnabled: true, outboundProxyUrl: "http://10.0.0.8:3128" }))).status).toBe(200);
    caller.local = false;
    caller.session = true;
    vi.stubEnv("ALLOW_PRIVATE_ENDPOINT_URLS", "true");
    try {
      expect((await PATCH(request({ outboundProxyEnabled: true, outboundProxyUrl: "http://10.0.0.9:3128" }))).status).toBe(200);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("PATCH /api/settings OIDC issuer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    caller.local = true;
    mocks.getSettings.mockResolvedValue({ oidcIssuerUrl: "https://idp.example.com", oidcClientId: "c", oidcClientSecret: "saved-secret" });
    mocks.updateSettings.mockImplementation(async (body) => body);
  });

  it("needs the client secret again to point OIDC at another issuer", async () => {
    for (const body of [{ oidcIssuerUrl: "https://other.example" }, { oidcIssuerUrl: "https://other.example", oidcClientSecret: "" }]) {
      const res = await PATCH(request(body));
      expect(res.status).toBe(400);
      expect(res.body.field).toBe("oidcClientSecret");
    }
    expect(mocks.updateSettings).not.toHaveBeenCalled();
    expect((await PATCH(request({ oidcIssuerUrl: "https://other.example", oidcClientSecret: "new-secret" }))).status).toBe(200);
  });

  it("refuses a private issuer from a remote session, since sign-in fetches from it", async () => {
    caller.local = false;
    const res = await PATCH(request({ oidcIssuerUrl: "http://10.0.0.5:8080/realms/r", oidcClientSecret: "new-secret" }));
    expect(res.status).toBe(400);
    expect(res.body.field).toBe("oidcIssuerUrl");
    expect((await PATCH(request({ oidcIssuerUrl: "https://203.0.113.20/realms/r", oidcClientSecret: "new-secret" }))).status).toBe(200);
    // The saved issuer, wherever it is, passes.
    mocks.getSettings.mockResolvedValue({ oidcIssuerUrl: "http://10.0.0.5:8080/realms/r", oidcClientSecret: "saved-secret" });
    expect((await PATCH(request({ oidcIssuerUrl: "http://10.0.0.5:8080/realms/r", oidcLoginLabel: "SSO" }))).status).toBe(200);
  });

  it("keeps the saved secret for the same issuer, and lets the issuer be cleared", async () => {
    expect((await PATCH(request({ oidcIssuerUrl: "https://idp.example.com/", oidcClientId: "c2" }))).status).toBe(200);
    expect((await PATCH(request({ oidcIssuerUrl: "" }))).status).toBe(200);
    expect(mocks.updateSettings).toHaveBeenCalledTimes(2);
  });
});
