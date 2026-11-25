import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(), update: vi.fn(), core: vi.fn(),
}));

vi.mock("../../src/lib/localDb.js", () => ({
  getProviderConnectionById: mocks.get,
  updateProviderConnection: mocks.update,
  getSettings: async () => ({ requireApiKey: false }),
  getCombos: async () => [],
}));
vi.mock("../../open-sse/services/oauthCredentialManager.js", () => ({
  refreshProviderCredentials: vi.fn(),
  shouldRefreshCredentials: () => false,
}));
vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: async () => ({ connectionId: "account", accessToken: "old" }),
  markAccountUnavailable: vi.fn(), clearAccountError: vi.fn(),
  extractApiKey: () => null, isValidApiKey: vi.fn(),
}));
vi.mock("../../src/sse/services/keyLimits.js", () => ({
  checkApiKeyLimits: async () => null,
  checkApiKeyExpiry: async () => null,
}));
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: async () => ({ provider: "xai", model: "imagine" }),
  getComboModels: async () => null,
  comboLookupName: (model) => model,
}));
vi.mock("@/shared/constants/providers.js", () => ({
  AI_PROVIDERS: { xai: { id: "xai", searchConfig: {}, fetchConfig: {} } },
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/shared/utils/ssrfGuard.js", () => ({ assertPublicUrlResolved: vi.fn() }));
vi.mock("../../src/sse/utils/logger.js", () => ({
  request: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}));
vi.mock("../../open-sse/handlers/imageGenerationCore.js", () => ({ handleImageGenerationCore: mocks.core }));
vi.mock("../../open-sse/handlers/search/index.js", () => ({ handleSearchCore: mocks.core }));
vi.mock("../../open-sse/handlers/fetch/index.js", () => ({ handleFetchCore: mocks.core }));
vi.mock("../../open-sse/handlers/videoCore.js", () => ({
  handleVideoProxyCore: mocks.core,
  getVideoConfig: () => ({}),
}));

import { updateProviderCredentials } from "../../src/sse/services/tokenRefresh.js";
import { handleImageGeneration } from "../../src/sse/handlers/imageGeneration.js";
import { handleSearch } from "../../src/sse/handlers/search.js";
import { handleFetch } from "../../src/sse/handlers/fetch.js";
import { handleVideoCreate, handleVideoGet } from "../../src/sse/handlers/videoGeneration.js";

// The shape refreshTokenByProvider returns for xai: no lastRefreshAt.
const refreshed = {
  accessToken: "new-access", refreshToken: "new-refresh", idToken: "new-identity", expiresIn: 3600,
};
const PATCH = { patchProviderSpecificData: true, stampLastRefreshAt: true, tokenRefresh: true };

function savedUpdate() {
  expect(mocks.update).toHaveBeenCalledOnce();
  const [connectionId, saved, options] = mocks.update.mock.calls[0];
  expect(connectionId).toBe("account");
  expect(options).toEqual(PATCH);
  return saved;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({ providerSpecificData: { accountId: "identity" } });
  mocks.update.mockResolvedValue({ id: "account" });
  mocks.core.mockImplementation(async ({ onCredentialsRefreshed }) => {
    await onCredentialsRefreshed(refreshed);
    return { success: true, response: Response.json({ ok: true }), data: { ok: true } };
  });
});

describe("updateProviderCredentials", () => {
  it("sends only the refresh's metadata, as a patch the repo applies over the stored row", async () => {
    expect(await updateProviderCredentials("account", {
      ...refreshed, providerSpecificData: { session: "new-session" },
    })).toEqual({ id: "account" });
    expect(savedUpdate().providerSpecificData).toEqual({ session: "new-session" });
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("passes extra options through and lets them override the defaults", async () => {
    await updateProviderCredentials("account", refreshed, { refreshTokenUsed: "old-refresh", stampLastRefreshAt: false });
    expect(mocks.update).toHaveBeenCalledWith("account", expect.any(Object), {
      patchProviderSpecificData: true, stampLastRefreshAt: false, tokenRefresh: true, refreshTokenUsed: "old-refresh",
    });
  });

  it("returns null when the repo wrote nothing", async () => {
    mocks.update.mockResolvedValueOnce(null);
    expect(await updateProviderCredentials("account", refreshed)).toBeNull();
  });

  it("lets a database error reach the caller", async () => {
    mocks.update.mockRejectedValueOnce(new Error("database is locked"));
    await expect(updateProviderCredentials("account", refreshed)).rejects.toThrow("database is locked");
  });

  it("leaves the lastRefreshAt stamp to the repo, which sees whether the token changed", async () => {
    await updateProviderCredentials("account", refreshed);
    expect(savedUpdate()).not.toHaveProperty("lastRefreshAt");
  });

  it("keeps the lastRefreshAt a refresh result carries", async () => {
    await updateProviderCredentials("account", { ...refreshed, lastRefreshAt: "2026-10-11T12:00:00.000Z" });
    expect(savedUpdate().lastRefreshAt).toBe("2026-10-11T12:00:00.000Z");
  });

  it("still saves the rotated tokens when expiresIn is not a number", async () => {
    expect(await updateProviderCredentials("account", {
      accessToken: "new-access", refreshToken: "rotated-refresh", expiresIn: "soon",
    })).toEqual({ id: "account" });
    const saved = savedUpdate();
    expect(saved).toMatchObject({ accessToken: "new-access", refreshToken: "rotated-refresh" });
    expect(saved).not.toHaveProperty("expiresIn");
    expect(saved).not.toHaveProperty("expiresAt");
  });

  it("falls back to expiresAt when expiresIn is not a number", async () => {
    await updateProviderCredentials("account", {
      accessToken: "new-access", expiresIn: "soon", expiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(savedUpdate().expiresAt).toBe("2099-01-01T00:00:00.000Z");
  });

  it("does not touch testStatus or the error fields; clearAccountError owns those", async () => {
    await updateProviderCredentials("account", { ...refreshed, testStatus: "active", lastError: null });
    const saved = savedUpdate();
    expect(saved).not.toHaveProperty("testStatus");
    expect(saved).not.toHaveProperty("lastError");
  });

  it("puts top-level Copilot fields in the same patch as providerSpecificData", async () => {
    await updateProviderCredentials("account", {
      providerSpecificData: { session: "new-session" }, copilotToken: "fresh-copilot", copilotTokenExpiresAt: 1234,
    });
    expect(savedUpdate().providerSpecificData).toEqual({
      session: "new-session", copilotToken: "fresh-copilot", copilotTokenExpiresAt: 1234,
    });
  });

  it("sends only the Copilot fields for a Copilot-only refresh", async () => {
    await updateProviderCredentials("account", { copilotToken: "fresh-copilot", copilotTokenExpiresAt: 1234 });
    expect(savedUpdate().providerSpecificData).toEqual({ copilotToken: "fresh-copilot", copilotTokenExpiresAt: 1234 });
  });
});

describe("gateway handler refresh callbacks", () => {
  it.each([
    ["image", (request) => handleImageGeneration(request)],
    ["search", (request) => handleSearch(request)],
    ["fetch", (request) => handleFetch(request)],
    ["video creation", (request) => handleVideoCreate(request, "generations")],
    ["video polling", () => handleVideoGet(new Request("http://localhost/v1/videos/job"), "job")],
  ])("persists the complete refresh result from %s", async (_name, handle) => {
    const before = Date.now();
    const response = await handle(new Request("http://localhost/v1/test", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "xai/imagine", provider: "xai", prompt: "hello", query: "hello", url: "https://example.com" }),
    }));
    expect(response.status).toBe(200);
    expect(mocks.core).toHaveBeenCalledOnce();
    const saved = savedUpdate();
    expect(saved).toMatchObject({
      accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken,
      idToken: refreshed.idToken, expiresIn: 3600,
    });
    expect(Date.parse(saved.expiresAt)).toBeGreaterThanOrEqual(before + 3600_000);
    expect(Date.parse(saved.expiresAt)).toBeLessThanOrEqual(Date.now() + 3600_000);
  });
});
