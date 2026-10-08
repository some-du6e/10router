import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  getSettings: vi.fn(),
  getModelInfo: vi.fn(),
  getComboModels: vi.fn(),
  handleChatCore: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(() => true),
}));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModels: mocks.getComboModels,
  comboLookupName: (model) => model,
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "http://headroom.test" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn() }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("open-sse/services/combo.js", async (importOriginal) => ({
  handleComboChat: (await importOriginal()).handleComboChat,
  handleFusionChat: vi.fn(),
  detectRequiredCapabilities: vi.fn(() => new Set()),
}));
vi.mock("open-sse/services/capacityAdapter.js", () => ({
  augmentModelsWithCapacityAdapter: vi.fn((models) => models),
  withCapacityAdapterStripping: vi.fn((fn) => fn),
  getActiveAdapterStrategy: vi.fn(),
}));
vi.mock("open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: vi.fn(() => null) }));
vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  maskKey: vi.fn((key) => key),
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: vi.fn(),
  checkAndRefreshToken: vi.fn(async (_provider, credentials) => credentials),
}));
vi.mock("open-sse/services/projectId.js", () => ({ getProjectIdForConnection: vi.fn() }));
vi.mock("@/sse/services/claudeBuiltinSearch.js", () => ({
  enrichClaudeBuiltinSearch: vi.fn(async (body) => body),
}));

const { handleChat } = await import("../../src/sse/handlers/chat.js");

function request(client = null) {
  return new Request("http://router.test/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(client ? { "user-agent": client } : {}) },
    body: JSON.stringify({ model: "opencode-go/glm-5.2", messages: [] }),
  });
}

function account(connectionId, connectionName) {
  return { connectionId, connectionName, apiKey: `${connectionId}-key`, providerSpecificData: {} };
}

describe("chat account failure responses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T12:00:00.000Z"));
    mocks.getSettings.mockResolvedValue({});
    mocks.getModelInfo.mockResolvedValue({ provider: "opencode-go", model: "glm-5.2" });
    mocks.getComboModels.mockResolvedValue(null);
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });
  });

  afterEach(() => vi.useRealTimers());

  it("returns every account failure with rate-limit retry metadata", async () => {
    const retryAfter = "2026-08-23T12:05:00.000Z";
    mocks.getProviderCredentials
      .mockResolvedValueOnce(account("primary", "Primary"))
      .mockResolvedValueOnce(account("backup", "Backup"))
      .mockResolvedValueOnce({
        allRateLimited: true,
        retryAfter,
        retryAfterHuman: "reset after 5m",
        lastErrorCode: 429,
      });
    mocks.handleChatCore
      .mockResolvedValueOnce({ success: false, status: 429, error: '{"error":{"message":"Weekly usage limit reached."}}' })
      .mockResolvedValueOnce({ success: false, status: 429, error: '{"error":{"message":"Monthly usage limit reached."}}' });

    const response = await handleChat(request());
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("300");
    expect(body.error.message).toContain("All 2 accounts unavailable for [opencode-go/glm-5.2]");
    expect(body.error.message).toContain("Primary (HTTP 429): Weekly usage limit reached.");
    expect(body.error.message).toContain("Backup (HTTP 429): Monthly usage limit reached.");
    expect(body.error.message).toContain("reset after 5m");
  });

  it("summarizes attempted accounts when no more credentials remain", async () => {
    mocks.getProviderCredentials
      .mockResolvedValueOnce(account("only", "Only account"))
      .mockResolvedValueOnce(null);
    mocks.handleChatCore.mockResolvedValueOnce({
      success: false,
      status: 503,
      error: "Upstream unavailable",
    });

    const response = await handleChat(request());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBeNull();
    expect(body.error.message).toBe(
      "All 1 accounts unavailable for [opencode-go/glm-5.2]. Only account (HTTP 503): Upstream unavailable"
    );
  });  it("automatically stops Codex after trying every limited account", async () => {
    mocks.getProviderCredentials
      .mockResolvedValueOnce(account("primary", "Primary"))
      .mockResolvedValueOnce(account("backup", "Backup"))
      .mockResolvedValueOnce(null);
    mocks.handleChatCore.mockResolvedValue({ success: false, status: 429, error: "Quota exhausted" });
    const response = await handleChat(request("codex-tui"));
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("All your accounts have hit their limits.");
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(2);
  });

  it("does not stop Codex when an outage precedes a limited account", async () => {
    mocks.getProviderCredentials
      .mockResolvedValueOnce(account("primary", "Primary"))
      .mockResolvedValueOnce(account("backup", "Backup"))
      .mockResolvedValueOnce(null);
    mocks.handleChatCore
      .mockResolvedValueOnce({ success: false, status: 503, error: "Unavailable" })
      .mockResolvedValueOnce({ success: false, status: 429, error: "Quota exhausted" });
    const response = await handleChat(request("codex-tui"));
    expect(response.status).toBe(429);
    expect(response.headers.has("x-should-retry")).toBe(false);
  });

  it("stops Codex on confirmed cached limits", async () => {
    mocks.getProviderCredentials.mockResolvedValueOnce({
      allRateLimited: true, allLimitsExhausted: true, lastErrorCode: 429,
      retryAfter: "2026-08-23T12:05:00.000Z", retryAfterHuman: "reset after 5m",
    });
    expect((await handleChat(request("codex-tui"))).status).toBe(400);
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });

  it("keeps unconfirmed cooldowns retryable for Codex", async () => {
    mocks.getProviderCredentials.mockResolvedValueOnce({
      allRateLimited: true, allLimitsExhausted: false, lastErrorCode: 429,
      retryAfter: "2026-08-23T12:05:00.000Z", retryAfterHuman: "reset after 5m",
    });
    expect((await handleChat(request("codex-tui"))).status).toBe(429);
  });

  it.each([true, false])("checks all fallback models before stopping, all limited: %s", async (allLimited) => {
    mocks.getComboModels.mockResolvedValue(["provider/first", "provider/second"]);
    mocks.getProviderCredentials
      .mockResolvedValueOnce(account("first", "First"))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(account("second", "Second"))
      .mockResolvedValueOnce(null);
    mocks.handleChatCore
      .mockResolvedValueOnce({ success: false, status: allLimited ? 429 : 500, error: allLimited ? "Quota exhausted" : "Unavailable" })
      .mockResolvedValueOnce({ success: false, status: 429, error: "Quota exhausted" });
    const response = await handleChat(request("codex-tui"));
    expect(response.status).toBe(allLimited ? 400 : 500);
    expect(response.headers.get("x-should-retry")).toBe(allLimited ? "false" : null);
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(2);
  });

});
