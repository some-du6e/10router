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
  sanitizeSecrets: (error) => error,
}));

import { updateProviderCredentials } from "../../src/sse/services/tokenRefresh.js";
import { handleImageGeneration } from "../../src/sse/handlers/imageGeneration.js";
import { handleSearch } from "../../src/sse/handlers/search.js";
import { handleFetch } from "../../src/sse/handlers/fetch.js";
import { handleVideoCreate, handleVideoGet } from "../../src/sse/handlers/videoGeneration.js";

const refreshed = {
  accessToken: "new-access", refreshToken: "new-refresh", idToken: "new-identity",
  expiresIn: 3600, lastRefreshAt: "2026-10-11T12:00:00.000Z",
  providerSpecificData: { session: "new-session" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({ providerSpecificData: { accountId: "identity", session: "old-session" } });
  mocks.update.mockResolvedValue({ id: "account" });
  mocks.core.mockImplementation(async ({ onCredentialsRefreshed }) => {
    await onCredentialsRefreshed(refreshed);
    return { success: true, response: Response.json({ ok: true }), data: { ok: true } };
  });
});

describe("gateway credential refresh persistence", () => {
  it("preserves stored metadata when the caller only supplies a refresh patch", async () => {
    expect(await updateProviderCredentials("account", refreshed)).toBe(true);
    expect(mocks.update).toHaveBeenCalledWith("account", expect.objectContaining({
      providerSpecificData: { accountId: "identity", session: "new-session" },
    }));
  });

  it("prefers current stored metadata to the caller's stale snapshot", async () => {
    await updateProviderCredentials("account", {
      ...refreshed, existingProviderSpecificData: { accountId: "stale", custom: "preserved" },
    });
    expect(mocks.update).toHaveBeenCalledWith("account", expect.objectContaining({
      providerSpecificData: { accountId: "identity", custom: "preserved", session: "new-session" },
    }));
  });

  it("preserves stored account metadata for top-level Copilot token refreshes", async () => {
    await updateProviderCredentials("account", { copilotToken: "fresh-copilot", copilotTokenExpiresAt: 1234 });
    expect(mocks.update).toHaveBeenCalledWith("account", expect.objectContaining({
      providerSpecificData: {
        accountId: "identity", session: "old-session", copilotToken: "fresh-copilot", copilotTokenExpiresAt: 1234,
      },
    }));
  });

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
    expect(mocks.update).toHaveBeenCalledOnce();
    const [connectionId, saved] = mocks.update.mock.calls[0];
    expect(connectionId).toBe("account");
    expect(saved).toMatchObject({
      accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken,
      idToken: refreshed.idToken, lastRefreshAt: refreshed.lastRefreshAt, expiresIn: 3600,
      providerSpecificData: { accountId: "identity", session: "new-session" },
    });
    expect(Date.parse(saved.expiresAt)).toBeGreaterThanOrEqual(before + 3600_000);
    expect(Date.parse(saved.expiresAt)).toBeLessThanOrEqual(Date.now() + 3600_000);
  });
});
