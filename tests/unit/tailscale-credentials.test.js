import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execSync: vi.fn(), spawn: vi.fn(), loadHostPassword: vi.fn(), saveHostPassword: vi.fn(),
  enableTailscale: vi.fn(), installTailscale: vi.fn(), configureTunnelMonitoring: vi.fn(), getSettings: vi.fn(),
}));
vi.mock("node:child_process", () => ({ execSync: mocks.execSync, spawn: mocks.spawn }));
vi.mock("@/lib/hostCredentials.js", () => ({ loadHostPassword: mocks.loadHostPassword, saveHostPassword: mocks.saveHostPassword }));
vi.mock("@/lib/tunnel", () => ({ enableTailscale: mocks.enableTailscale, installTailscale: mocks.installTailscale, loadState: () => null, generateShortId: () => "test" }));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));
vi.mock("@/shared/services/initializeApp", () => ({ configureTunnelMonitoring: mocks.configureTunnelMonitoring }));

const { loadPassword, rememberPassword, setCachedPassword } = await import("../../src/lib/tunnel/tailscale/sudo.js");
const { POST } = await import("../../src/app/api/tunnel/tailscale-enable/route.js");
const { POST: install } = await import("../../src/app/api/tunnel/tailscale-install/route.js");

beforeEach(() => {
  vi.clearAllMocks();
  setCachedPassword("");
  mocks.loadHostPassword.mockResolvedValue("previous-password");
  mocks.saveHostPassword.mockResolvedValue(undefined);
  mocks.execSync.mockReturnValue("/usr/bin/sudo");
  mocks.getSettings.mockResolvedValue({});
});

function authenticationResult(code) {
  mocks.spawn.mockImplementation(() => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = () => queueMicrotask(() => child.emit("close", code));
    return child;
  });
}

describe("Independent Tailscale elevation credentials", () => {
  it("reports a successful install even when its credential cannot be saved", async () => {
    authenticationResult(1);
    mocks.installTailscale.mockResolvedValue({ authUrl: "https://login.tailscale.com/test" });
    const response = await install(new Request("http://localhost/api/tunnel/tailscale-install", {
      method: "POST", body: JSON.stringify({ sudoPassword: "wrong-password" }),
    }));
    const events = await response.text();
    expect(events).toContain('event: done\ndata: {"success":true');
    expect(events).toContain("credential was not saved");
    expect(events).not.toContain("event: error");
    expect(mocks.saveHostPassword).not.toHaveBeenCalled();
  });

  it("returns an explicit credential-recovery response after cached recovery fails", async () => {
    const error = new Error("New sudo password required");
    error.code = "TAILSCALE_SUDO_PASSWORD_REQUIRED";
    mocks.enableTailscale.mockRejectedValueOnce(error);
    const response = await POST(new Request("http://localhost/api/tunnel/tailscale-enable", { method: "POST", body: "{}" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ needsSudoPassword: true });
  });

  it("loads the stored credential after the process cache is empty", async () => {
    expect(await loadPassword()).toBe("previous-password");
    expect(mocks.loadHostPassword).toHaveBeenCalledWith("tailscale");
  });

  it("forces sudo authentication before replacing a saved credential", async () => {
    authenticationResult(0);
    await rememberPassword("replacement-password");
    expect(mocks.spawn.mock.calls[0][1]).toEqual(["-S", "-k", "sh", "-c", "true"]);
    expect(mocks.saveHostPassword).toHaveBeenCalledWith("tailscale", "replacement-password");
    expect(await loadPassword()).toBe("replacement-password");
  });

  it("preserves a working saved password when authentication fails", async () => {
    authenticationResult(1);
    await expect(rememberPassword("wrong-password")).rejects.toThrow();
    expect(mocks.saveHostPassword).not.toHaveBeenCalled();
    expect(await loadPassword()).toBe("previous-password");
  });

  it("accepts a replacement password through the local enable API", async () => {
    mocks.enableTailscale.mockResolvedValue({ success: true });
    const response = await POST(new Request("http://localhost/api/tunnel/tailscale-enable", {
      method: "POST", body: JSON.stringify({ sudoPassword: "replacement-password" }),
    }));
    expect(response.status).toBe(200);
    expect(mocks.enableTailscale).toHaveBeenCalledWith(20128, "replacement-password");
  });

  it.each([123, {}, "bad\npassword", "bad\0password"])("rejects malformed elevation credentials", async (sudoPassword) => {
    const response = await POST(new Request("http://localhost/api/tunnel/tailscale-enable", {
      method: "POST", body: JSON.stringify({ sudoPassword }),
    }));
    expect(response.status).toBe(400);
    expect(mocks.enableTailscale).not.toHaveBeenCalled();
  });
});
