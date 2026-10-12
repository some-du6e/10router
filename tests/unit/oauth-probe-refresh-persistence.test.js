import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testSingleConnection } from "../../src/app/api/providers/[id]/test/testUtils.js";

const { get, update, refresh, expired } = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), refresh: vi.fn(), expired: vi.fn() }));
vi.mock("@/lib/localDb", () => ({ getProviderConnectionById: get, updateProviderConnection: update }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: async () => ({}) }));
vi.mock("open-sse/services/oauthCredentialManager.js", () => ({ refreshProviderCredentials: refresh, shouldRefreshCredentials: expired }));

const connection = { id: "account-a", provider: "codex", authType: "oauth", accessToken: "old-access", refreshToken: "old-refresh" };
const rotated = { accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 3600 };

beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue({ ...connection });
  update.mockResolvedValue({});
  refresh.mockResolvedValue({ ...rotated });
  expired.mockReturnValue(false);
});
afterEach(() => vi.unstubAllGlobals());

describe("connection probes preserve successful token rotation", () => {
  it.each([403, 500])("persists rotated tokens when the retry probe returns %s", async (status) => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(new Response("probe failed", { status }));
    vi.stubGlobal("fetch", fetch);
    const result = await testSingleConnection("account-a");
    expect(result).toMatchObject({ valid: false, refreshed: true });
    expect(update).toHaveBeenCalledWith("account-a", expect.objectContaining({
      accessToken: "new-access", refreshToken: "new-refresh", testStatus: "error", expiresIn: 3600,
    }));
    expect(fetch.mock.calls[1][1].headers.Authorization).toBe("Bearer new-access");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("persists rotated tokens when the retry throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockRejectedValueOnce(new Error("probe timeout")));
    expect(await testSingleConnection("account-a")).toMatchObject({ valid: false, refreshed: true, error: "probe timeout" });
    expect(update).toHaveBeenCalledWith("account-a", expect.objectContaining(rotated));
  });

  it("persists proactive refresh even when the first probe fails", async () => {
    expired.mockReturnValue(true);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("denied", { status: 403 })));
    expect(await testSingleConnection("account-a")).toMatchObject({ valid: false, refreshed: true });
    expect(update).toHaveBeenCalledWith("account-a", expect.objectContaining(rotated));
  });

  it.each(["gemini-cli", "antigravity", "cline"])("preserves %s rotation when its probe throws", async (provider) => {
    get.mockResolvedValue({ ...connection, provider });
    expired.mockReturnValue(true);
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600,
        accessToken: "new-access", refreshToken: "new-refresh" }))
      .mockRejectedValueOnce(new Error("provider unreachable")));
    expect(await testSingleConnection("account-a")).toMatchObject({ valid: false, refreshed: true, error: "provider unreachable" });
    expect(update).toHaveBeenCalledWith("account-a", expect.objectContaining({ accessToken: "new-access", refreshToken: "new-refresh" }));
  });

  it("does not reuse the old Cline refresh token after a proactive refresh", async () => {
    get.mockResolvedValue({ ...connection, provider: "cline" });
    expired.mockReturnValue(true);
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ accessToken: "new-access", refreshToken: "new-refresh" }))
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));
    vi.stubGlobal("fetch", fetch);
    expect(await testSingleConnection("account-a")).toMatchObject({ valid: false, refreshed: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledWith("account-a", expect.objectContaining({ accessToken: "new-access", refreshToken: "new-refresh" }));
  });

  it("keeps successful probe behavior and records rotated expiry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(new Response("invalid body", { status: 400 })));
    expect(await testSingleConnection("account-a")).toMatchObject({ valid: true, refreshed: true });
    expect(update).toHaveBeenCalledWith("account-a", expect.objectContaining({ ...rotated, testStatus: "active", expiresAt: expect.any(String) }));
  });

  it("does not report or persist a refresh without an access token", async () => {
    refresh.mockResolvedValue({ refreshToken: "incomplete" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 })));
    expect(await testSingleConnection("account-a")).toMatchObject({ valid: false, refreshed: false });
    expect(update.mock.calls[0][1]).not.toHaveProperty("accessToken");
    expect(update.mock.calls[0][1]).not.toHaveProperty("refreshToken");
  });
});
