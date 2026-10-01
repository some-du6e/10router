import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), refresh: vi.fn(), shouldRefresh: vi.fn(), executorRefresh: vi.fn(), needsRefresh: vi.fn() }));
vi.mock("../../src/lib/localDb.js", () => ({ getProviderConnectionById: mocks.get, updateProviderConnection: mocks.update }));
vi.mock("../../open-sse/services/oauthCredentialManager.js", () => ({ refreshProviderCredentials: mocks.refresh, shouldRefreshCredentials: mocks.shouldRefresh }));
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: () => ({ refreshCredentials: mocks.executorRefresh, needsRefresh: mocks.needsRefresh }) }));
vi.mock("../../open-sse/index.js", () => ({}));

import { checkAndRefreshToken } from "../../src/sse/services/tokenRefresh.js";
import { GET, refreshAndUpdateCredentials } from "../../src/app/api/usage/[connectionId]/route.js";

const stale = { id: "account", connectionId: "account", provider: "codex", refreshToken: "old-refresh", accessToken: "old-access", lastRefreshAt: "2026-10-01T10:00:00Z" };
const latest = { ...stale, refreshToken: "new-refresh", accessToken: "new-access", expiresAt: "2026-10-01T12:00:00Z", lastRefreshAt: "2026-10-01T11:00:00Z" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.get.mockResolvedValue(latest);
  mocks.update.mockResolvedValue(latest);
  mocks.needsRefresh.mockReturnValue(true);
});

describe("Codex stale refresh snapshots", () => {
  it("does not apply an old access token's expiry to an adopted token", async () => {
    mocks.get.mockResolvedValue({ ...latest, expiresAt: undefined });
    mocks.shouldRefresh.mockReturnValue(false);
    const result = await checkAndRefreshToken("codex", { ...stale, expiresAt: "2020-01-01T00:00:00Z" });
    expect(result.expiresAt).toBeNull();
    expect(mocks.shouldRefresh).toHaveBeenCalledWith("codex", expect.objectContaining({ accessToken: "new-access", expiresAt: null }));
  });

  it("retains the expiry when only the refresh token changes", async () => {
    mocks.get.mockResolvedValue({ ...latest, accessToken: undefined });
    mocks.shouldRefresh.mockReturnValue(false);
    const result = await checkAndRefreshToken("codex", { ...stale, expiresAt: "2026-10-01T13:00:00Z" });
    expect(result).toMatchObject({ accessToken: "old-access", expiresAt: "2026-10-01T13:00:00Z" });
  });

  it("returns a transient server error when usage cannot reread credentials", async () => {
    mocks.get.mockResolvedValueOnce({ ...stale, authType: "oauth" }).mockRejectedValueOnce(new Error("Database unavailable"));
    const response = await GET(new Request("http://localhost/api/usage/account"), { params: Promise.resolve({ connectionId: "account" }) });
    expect(response.status).toBe(500);
    expect((await response.json()).error).toContain("Please retry");
    expect(mocks.executorRefresh).not.toHaveBeenCalled();
  });
  it("adopts persisted tokens before deciding whether a request needs refresh", async () => {
    mocks.shouldRefresh.mockReturnValue(false);
    const result = await checkAndRefreshToken("codex", stale);
    expect(result).toMatchObject({ refreshToken: "new-refresh", accessToken: "new-access", expiresAt: latest.expiresAt });
    expect(mocks.shouldRefresh).toHaveBeenCalledWith("codex", expect.objectContaining({ refreshToken: "new-refresh" }));
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("refreshes using the persisted token even when forced", async () => {
    mocks.refresh.mockResolvedValue({ accessToken: "next-access", refreshToken: "next-refresh", expiresIn: 3600 });
    const result = await checkAndRefreshToken("codex", stale, { force: true });
    expect(mocks.refresh).toHaveBeenCalledWith("codex", expect.objectContaining({ refreshToken: "new-refresh" }), expect.any(Object));
    expect(result.refreshToken).toBe("next-refresh");
    expect(mocks.update).toHaveBeenCalledWith("account", expect.objectContaining({ refreshToken: "next-refresh" }));
  });

  it("does not replace a request snapshot with older DB tokens", async () => {
    mocks.get.mockResolvedValue(stale);
    mocks.shouldRefresh.mockReturnValue(false);
    expect((await checkAndRefreshToken("codex", latest)).refreshToken).toBe("new-refresh");
  });

  it("usage polling rereads the connection before refreshing", async () => {
    mocks.executorRefresh.mockResolvedValue({ accessToken: "next-access", refreshToken: "next-refresh", expiresIn: 3600 });
    expect(await refreshAndUpdateCredentials(stale)).toMatchObject({ refreshed: true, connection: { accessToken: "next-access" } });
    expect(mocks.executorRefresh).toHaveBeenCalledWith(expect.objectContaining({ refreshToken: "new-refresh" }), console, null);
  });

  it("usage polling stops on a revoked token rather than trying its old access token", async () => {
    mocks.executorRefresh.mockResolvedValue({ error: "refresh_token_reused" });
    await expect(refreshAndUpdateCredentials(stale)).rejects.toThrow("Please re-authorize");
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
