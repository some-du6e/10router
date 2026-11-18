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
let tempDir, db, sseRefresh, oauth, engineRefresh;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-refresh-patch-"));
  process.env.DATA_DIR = tempDir;
  // proxyFetch keeps the fetch it finds at import, so install the stub first.
  global.fetch = (...args) => fetchImpl(...args);
  vi.resetModules();
  db = await import("../../src/lib/db/index.js");
  sseRefresh = await import("../../src/sse/services/tokenRefresh.js");
  oauth = await import("../../open-sse/services/oauthCredentialManager.js");
  engineRefresh = await import("../../open-sse/services/tokenRefresh.js");
});

afterEach(() => {
  fetchImpl = unexpectedFetch;
});

afterAll(() => {
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

  it("shared refreshProviderCredentials path", async () => {
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
