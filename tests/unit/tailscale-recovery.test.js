import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadPassword: vi.fn(), rememberPassword: vi.fn(), verifyPassword: vi.fn(),
  startDaemonWithPassword: vi.fn(), startLogin: vi.fn(),
  isDaemonTunMode: vi.fn(),
}));
vi.mock("../../src/lib/tunnel/tailscale/sudo.js", () => ({ ...mocks, validatePassword: () => {} }));
vi.mock("../../src/lib/tunnel/shared/state.js", () => ({ loadState: () => null, generateShortId: () => "test" }));
vi.mock("../../src/lib/tunnel/tailscale/healthCheck.js", () => ({ waitForHealth: vi.fn() }));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({ tailscaleEnabled: true }), updateSettings: vi.fn() }));
vi.mock("../../src/lib/tunnel/tailscale/tailscale.js", () => ({
  startDaemonWithPassword: mocks.startDaemonWithPassword, startLogin: mocks.startLogin,
  isDaemonTunMode: mocks.isDaemonTunMode,
  startFunnel: vi.fn(), stopFunnel: vi.fn(), provisionCert: vi.fn(),
  isTailscaleRunning: () => false, isTailscaleRunningStrict: () => false,
  isTailscaleLoggedIn: () => false, isTailscaleLoggedInStrict: () => false,
}));

const { enableTailscale, getTailscaleService, getTailscaleStatus } = await import("../../src/lib/tunnel/tailscale/manager.js");
beforeEach(() => {
  vi.resetAllMocks();
  getTailscaleService().needsSudoPassword = false;
  mocks.loadPassword.mockResolvedValue("stale-password");
  mocks.verifyPassword.mockRejectedValue(new Error("Wrong password"));
  mocks.startLogin.mockResolvedValue({ authUrl: "https://login.tailscale.com/test" });
});

describe("Tailscale privileged restart recovery", () => {
  it("exposes a stale-credential recovery state without downgrading to userspace", async () => {
    await expect(enableTailscale()).rejects.toMatchObject({ code: "TAILSCALE_SUDO_PASSWORD_REQUIRED" });
    expect(mocks.startDaemonWithPassword).not.toHaveBeenCalled();
    expect(await getTailscaleStatus()).toMatchObject({ settingsEnabled: true, needsSudoPassword: true });
  });

  it("clears the recovery state when the user supplies a replacement credential", async () => {
    getTailscaleService().needsSudoPassword = true;
    await enableTailscale(20128, "new-password");
    expect(mocks.rememberPassword).toHaveBeenCalledWith("new-password");
    expect(mocks.startDaemonWithPassword).toHaveBeenCalledWith("new-password");
    expect(getTailscaleService().needsSudoPassword).toBe(false);
  });

  it.skipIf(process.platform === "win32")("requests a credential after restoring settings without host credentials", async () => {
    mocks.loadPassword.mockResolvedValue("");
    mocks.isDaemonTunMode.mockReturnValue(null);
    await expect(enableTailscale()).rejects.toMatchObject({ code: "TAILSCALE_SUDO_PASSWORD_REQUIRED" });
    expect(mocks.startDaemonWithPassword).not.toHaveBeenCalled();
    expect(getTailscaleService().needsSudoPassword).toBe(true);
  });

  it("reuses an existing TUN daemon without a saved credential", async () => {
    mocks.loadPassword.mockResolvedValue("");
    mocks.isDaemonTunMode.mockReturnValue(true);
    await enableTailscale();
    expect(mocks.startDaemonWithPassword).toHaveBeenCalledWith("");
    expect(getTailscaleService().needsSudoPassword).toBe(false);
  });

  it("starts the Windows service without verifying an unused saved sudo password", async () => {
    vi.stubGlobal("process", new Proxy(process, {
      get(target, key) { return key === "platform" ? "win32" : Reflect.get(target, key); },
    }));
    try {
      await enableTailscale();
      expect(mocks.verifyPassword).not.toHaveBeenCalled();
      expect(mocks.startDaemonWithPassword).toHaveBeenCalledWith("stale-password");
      expect(getTailscaleService().needsSudoPassword).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
