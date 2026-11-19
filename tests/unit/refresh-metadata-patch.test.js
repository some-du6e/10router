import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Refresh results carry the caller's (possibly stale) metadata. These run on a
// real database so they show what the stored row ends up holding.

const originalDataDir = process.env.DATA_DIR;
const originalFetch = global.fetch;
const TOKEN_ENDPOINT = "https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token";
const unexpectedFetch = async (url) => { throw new Error(`unexpected fetch: ${url}`); };
let fetchImpl = unexpectedFetch;
const executorRefresh = vi.fn();
let tempDir, db, sseRefresh, oauth, engineRefresh, GithubExecutor, GeminiCLIExecutor, AntigravityExecutor, usageRoute;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-refresh-patch-"));
  process.env.DATA_DIR = tempDir;
  // proxyFetch keeps the fetch it finds at import, so install the stub first.
  global.fetch = (...args) => fetchImpl(...args);
  vi.resetModules();
  vi.doMock("../../open-sse/executors/index.js", () => ({
    getExecutor: () => ({ refreshCredentials: executorRefresh, needsRefresh: () => true }),
  }));
  // The usage route imports the engine entry only to patch fetch.
  vi.doMock("../../open-sse/index.js", () => ({}));
  db = await import("../../src/lib/db/index.js");
  sseRefresh = await import("../../src/sse/services/tokenRefresh.js");
  oauth = await import("../../open-sse/services/oauthCredentialManager.js");
  engineRefresh = await import("../../open-sse/services/tokenRefresh.js");
  ({ GithubExecutor } = await import("../../open-sse/executors/github.js"));
  ({ GeminiCLIExecutor } = await import("../../open-sse/executors/gemini-cli.js"));
  ({ AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js"));
  usageRoute = await import("../../src/app/api/usage/[connectionId]/route.js");
});

afterEach(() => {
  fetchImpl = unexpectedFetch;
});

afterAll(() => {
  vi.doUnmock("../../open-sse/executors/index.js");
  vi.doUnmock("../../open-sse/index.js");
  global.fetch = originalFetch;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const addConnection = (provider, providerSpecificData) => db.createProviderConnection({
  provider, authType: "oauth", accessToken: "stored-access", refreshToken: "stored-refresh", providerSpecificData,
});
const storedData = async (id) => (await db.getProviderConnectionById(id)).providerSpecificData;

describe("updateProviderConnection patchProviderSpecificData", () => {
  it("applies the patch over the stored metadata", async () => {
    const conn = await addConnection("xai", { accountId: "stored", session: "old" });
    await db.updateProviderConnection(conn.id, { providerSpecificData: { session: "new" } }, { patchProviderSpecificData: true });
    expect(await storedData(conn.id)).toEqual({ accountId: "stored", session: "new" });
  });

  it("replaces the metadata without the option", async () => {
    const conn = await addConnection("xai", { accountId: "stored", session: "old" });
    await db.updateProviderConnection(conn.id, { providerSpecificData: { session: "new" } });
    expect(await storedData(conn.id)).toEqual({ session: "new" });
  });

  it("treats a null patch as empty and skips undefined values", async () => {
    const conn = await addConnection("xai", { accountId: "stored", session: "old" });
    await db.updateProviderConnection(conn.id, { providerSpecificData: null }, { patchProviderSpecificData: true });
    expect(await storedData(conn.id)).toEqual({ accountId: "stored", session: "old" });
    await db.updateProviderConnection(conn.id, { providerSpecificData: { session: undefined, plan: "new" } }, { patchProviderSpecificData: true });
    expect(await storedData(conn.id)).toEqual({ accountId: "stored", session: "old", plan: "new" });
  });
});

describe("updateProviderConnection refreshTokenUsed with the refresh options", () => {
  it("applies the patch and the stamp only when the compare-and-set passes", async () => {
    const conn = await addConnection("xai", { accountId: "stored" });
    await db.updateProviderConnection(conn.id, { lastRefreshAt: "2026-01-01T00:00:00.000Z" });
    const options = { refreshTokenUsed: ["stored-refresh", "rotated-refresh"], patchProviderSpecificData: true, stampLastRefreshAt: true };

    const saved = await sseRefresh.updateProviderCredentials(conn.id, {
      accessToken: "rotated-access", refreshToken: "rotated-refresh", providerSpecificData: { session: "s1" },
    }, { refreshTokenUsed: options.refreshTokenUsed });
    expect(saved).toMatchObject({ accessToken: "rotated-access", refreshToken: "rotated-refresh" });
    const stored = await db.getProviderConnectionById(conn.id);
    expect(stored.providerSpecificData).toEqual({ accountId: "stored", session: "s1" });
    expect(stored.lastRefreshAt).not.toBe("2026-01-01T00:00:00.000Z");

    // The row moved on to a token this write didn't use: nothing lands.
    expect(await db.updateProviderConnection(conn.id, { accessToken: "late-access", providerSpecificData: { session: "late" } },
      { ...options, refreshTokenUsed: "stored-refresh" })).toBeNull();
    expect(await db.getProviderConnectionById(conn.id)).toMatchObject({
      accessToken: "rotated-access", providerSpecificData: { accountId: "stored", session: "s1" },
    });
  });
});

describe("updateProviderConnection stampLastRefreshAt", () => {
  it("stamps lastRefreshAt only when the access token changes", async () => {
    const conn = await addConnection("xai", { accountId: "stored" });
    await db.updateProviderConnection(conn.id, { lastRefreshAt: "2026-01-01T00:00:00.000Z" });
    await db.updateProviderConnection(conn.id, { accessToken: "stored-access" }, { stampLastRefreshAt: true });
    expect((await db.getProviderConnectionById(conn.id)).lastRefreshAt).toBe("2026-01-01T00:00:00.000Z");

    const before = Date.now();
    await db.updateProviderConnection(conn.id, { accessToken: "new-access" }, { stampLastRefreshAt: true });
    expect(Date.parse((await db.getProviderConnectionById(conn.id)).lastRefreshAt)).toBeGreaterThanOrEqual(before);
  });

  it("keeps a lastRefreshAt the write carries", async () => {
    const conn = await addConnection("xai", {});
    await db.updateProviderConnection(conn.id, { accessToken: "new-access", lastRefreshAt: "2026-02-02T00:00:00.000Z" }, { stampLastRefreshAt: true });
    expect((await db.getProviderConnectionById(conn.id)).lastRefreshAt).toBe("2026-02-02T00:00:00.000Z");
  });
});

describe("refresh results keep newer stored metadata", () => {
  it("Copilot proactive refresh", async () => {
    const conn = await addConnection("github", { githubLogin: "renamed-login" });
    fetchImpl = vi.fn(async () => Response.json({ token: "fresh-copilot", expires_at: 4102444800 }));
    const result = await sseRefresh.checkAndRefreshToken("github", {
      connectionId: conn.id,
      accessToken: "copilot-gh-access",
      expiresAt: "2099-01-01T00:00:00.000Z",
      providerSpecificData: { githubLogin: "stale-login" },
    });
    expect(result.providerSpecificData.copilotToken).toBe("fresh-copilot");
    expect(await storedData(conn.id)).toEqual({
      githubLogin: "renamed-login", copilotToken: "fresh-copilot", copilotTokenExpiresAt: 4102444800,
    });
  });

  it("Copilot token saved through updateProviderCredentials", async () => {
    const conn = await addConnection("github", { githubLogin: "renamed-login", copilotToken: "old" });
    await sseRefresh.updateProviderCredentials(conn.id, { copilotToken: "fresh-copilot", copilotTokenExpiresAt: 1234 });
    expect(await storedData(conn.id)).toEqual({
      githubLogin: "renamed-login", copilotToken: "fresh-copilot", copilotTokenExpiresAt: 1234,
    });
  });

  it("Kiro external_idp refresh", async () => {
    const config = { authMethod: "external_idp", clientId: "client-id", tokenEndpoint: TOKEN_ENDPOINT, scope: "offline_access" };
    const conn = await addConnection("kiro", { ...config, profileArn: "profile-new", region: "eu-west-1" });
    fetchImpl = vi.fn(async () => Response.json({
      access_token: "kiro-access", refresh_token: "kiro-rotated", expires_in: 3600,
    }));
    const refreshed = await engineRefresh.refreshKiroToken("kiro-refresh", { ...config, profileArn: "profile-stale", region: "us-east-1" });
    expect(refreshed.providerSpecificData).toEqual(config);
    await sseRefresh.updateProviderCredentials(conn.id, refreshed);
    const stored = await db.getProviderConnectionById(conn.id);
    expect(stored).toMatchObject({ accessToken: "kiro-access", refreshToken: "kiro-rotated" });
    expect(stored.providerSpecificData).toEqual({ ...config, profileArn: "profile-new", region: "eu-west-1" });
  });

  it("GitHub Copilot-only refresh leaves the stored GitHub tokens and lastRefreshAt alone", async () => {
    const conn = await addConnection("github", { githubLogin: "login" });
    await db.updateProviderConnection(conn.id, { refreshToken: "newest-refresh", lastRefreshAt: "2026-11-01T00:00:00.000Z" });
    fetchImpl = vi.fn(async () => Response.json({ token: "fresh-copilot", expires_at: 4102444800 }));
    const refreshed = await new GithubExecutor().refreshCredentials({ accessToken: "stored-access", refreshToken: "stale-refresh" }, null);
    expect(refreshed).toEqual({ copilotToken: "fresh-copilot", copilotTokenExpiresAt: 4102444800 });
    await sseRefresh.updateProviderCredentials(conn.id, refreshed);
    expect(await db.getProviderConnectionById(conn.id)).toMatchObject({
      accessToken: "stored-access", refreshToken: "newest-refresh", lastRefreshAt: "2026-11-01T00:00:00.000Z",
      providerSpecificData: { githubLogin: "login", copilotToken: "fresh-copilot", copilotTokenExpiresAt: 4102444800 },
    });
  });

  it("usage polling keeps metadata stored while its refresh ran", async () => {
    const config = { authMethod: "external_idp", clientId: "client-id", tokenEndpoint: TOKEN_ENDPOINT, scope: "offline_access" };
    const conn = await addConnection("kiro", { ...config, profileArn: "profile-old", region: "eu-west-1" });
    executorRefresh.mockImplementationOnce(async (credentials) => {
      expect(credentials.providerSpecificData.profileArn).toBe("profile-old");
      // Another request stores a newer profile after the route read the row.
      await db.updateProviderConnection(conn.id, { providerSpecificData: { ...credentials.providerSpecificData, profileArn: "profile-newer" } });
      return { accessToken: "usage-access", refreshToken: "usage-rotated", expiresIn: 3600, providerSpecificData: config };
    });
    const { connection, refreshed } = await usageRoute.refreshAndUpdateCredentials({ id: conn.id }, true);
    expect(refreshed).toBe(true);
    expect(connection).toMatchObject({ accessToken: "usage-access", refreshToken: "usage-rotated" });
    expect(await db.getProviderConnectionById(conn.id)).toMatchObject({
      accessToken: "usage-access", refreshToken: "usage-rotated",
      providerSpecificData: { ...config, profileArn: "profile-newer", region: "eu-west-1" },
    });
  });

  it("usage polling still saves the rotated token when expiresIn is not a number", async () => {
    const conn = await addConnection("kiro", { region: "eu-west-1" });
    executorRefresh.mockResolvedValueOnce({ accessToken: "usage-access-2", refreshToken: "usage-rotated-2", expiresIn: "soon" });
    const { refreshed } = await usageRoute.refreshAndUpdateCredentials({ id: conn.id }, true);
    expect(refreshed).toBe(true);
    expect(await db.getProviderConnectionById(conn.id)).toMatchObject({
      accessToken: "usage-access-2", refreshToken: "usage-rotated-2",
    });
  });

  it.each([
    ["gemini-cli", () => new GeminiCLIExecutor()],
    ["antigravity", () => new AntigravityExecutor()],
  ])("%s refresh echoes neither the request's refresh token nor its projectId", async (provider, makeExecutor) => {
    const conn = await db.createProviderConnection({
      provider, authType: "oauth", accessToken: "stored-access", refreshToken: "newest-refresh", projectId: "project-newest",
    });
    fetchImpl = vi.fn(async () => Response.json({ access_token: `${provider}-access`, expires_in: 3600 }));
    const refreshed = await makeExecutor().refreshCredentials({
      connectionId: conn.id, accessToken: "stale-access", refreshToken: "stale-refresh", projectId: "project-stale",
    }, null);
    expect(refreshed).toMatchObject({ accessToken: `${provider}-access`, expiresIn: 3600 });
    expect(refreshed).not.toHaveProperty("refreshToken");
    expect(refreshed).not.toHaveProperty("projectId");
    await sseRefresh.updateProviderCredentials(conn.id, refreshed);
    expect(await db.getProviderConnectionById(conn.id)).toMatchObject({
      accessToken: `${provider}-access`, refreshToken: "newest-refresh", projectId: "project-newest",
    });
  });

  it("mergeRefreshedCredentials leaves out tokens the refresher didn't return", async () => {
    const conn = await addConnection("codex", { chatgptAccountId: "account" });
    await db.updateProviderConnection(conn.id, { refreshToken: "newest-refresh", idToken: "newest-id" });
    const refreshed = oauth.mergeRefreshedCredentials("codex", {
      connectionId: conn.id, refreshToken: "stale-refresh", idToken: "stale-id",
    }, { accessToken: "codex-access-3", expiresIn: 3600 });
    expect(refreshed).not.toHaveProperty("refreshToken");
    expect(refreshed).not.toHaveProperty("idToken");
    await sseRefresh.updateProviderCredentials(conn.id, refreshed);
    expect(await db.getProviderConnectionById(conn.id)).toMatchObject({
      accessToken: "codex-access-3", refreshToken: "newest-refresh", idToken: "newest-id",
    });
  });

  it("mergeRefreshedCredentials ignores a non-numeric expiresIn and keeps the rotated token", async () => {
    const conn = await addConnection("codex", { chatgptAccountId: "account" });
    const refreshed = oauth.mergeRefreshedCredentials("codex", { connectionId: conn.id, refreshToken: "stored-refresh" }, {
      accessToken: "codex-access", refreshToken: "codex-rotated", expiresIn: "soon",
    });
    expect(refreshed).toMatchObject({ accessToken: "codex-access", refreshToken: "codex-rotated" });
    expect(refreshed).not.toHaveProperty("expiresAt");
    await sseRefresh.updateProviderCredentials(conn.id, refreshed);
    expect((await db.getProviderConnectionById(conn.id)).refreshToken).toBe("codex-rotated");
  });

  it("mergeRefreshedCredentials", async () => {
    const conn = await addConnection("codex", { chatgptAccountId: "account", workspace: "renamed" });
    const current = {
      connectionId: conn.id, refreshToken: "stored-refresh",
      providerSpecificData: { chatgptAccountId: "account", workspace: "stale" },
    };
    const refreshed = oauth.mergeRefreshedCredentials("codex", current, {
      accessToken: "codex-access", refreshToken: "codex-rotated", expiresIn: 3600, providerSpecificData: { session: "s2" },
    });
    expect(refreshed.providerSpecificData).toEqual({ session: "s2" });

    // The request's own copy still has every field for its retry.
    expect(oauth.applyRefreshedCredentials({ ...current }, refreshed).providerSpecificData).toEqual({
      chatgptAccountId: "account", workspace: "stale", session: "s2",
    });

    await sseRefresh.updateProviderCredentials(conn.id, refreshed);
    expect(await storedData(conn.id)).toEqual({ chatgptAccountId: "account", workspace: "renamed", session: "s2" });
  });
});
