import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: vi.fn(), modelInfo: vi.fn(), comboModels: vi.fn(), credentials: vi.fn(),
  embeddings: vi.fn(), tts: vi.fn(), saveUsage: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.settings, getCombos: vi.fn() }));
vi.mock("@/lib/db/index.js", () => ({ getSettings: mocks.settings }));
vi.mock("@/sse/services/auth.js", () => ({
  extractApiKey: () => null, isValidApiKey: vi.fn(),
  getProviderCredentials: mocks.credentials, markAccountUnavailable: vi.fn(), clearAccountError: vi.fn(),
}));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: mocks.modelInfo, getComboModels: mocks.comboModels, comboLookupName: (name) => name,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_, credentials) => credentials, updateProviderCredentials: vi.fn(),
}));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: mocks.saveUsage }));
vi.mock("@/sse/utils/logger.js", () => ({
  request: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), maskKey: vi.fn(),
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: vi.fn(), clientReceivesStream: vi.fn() }));
vi.mock("open-sse/handlers/embeddingsCore.js", () => ({ handleEmbeddingsCore: mocks.embeddings }));
vi.mock("open-sse/handlers/ttsCore.js", () => ({ handleTtsCore: mocks.tts }));
vi.mock("open-sse/handlers/imageGenerationCore.js", () => ({ handleImageGenerationCore: vi.fn() }));
vi.mock("open-sse/handlers/search/index.js", () => ({ handleSearchCore: vi.fn() }));
vi.mock("open-sse/handlers/fetch/index.js", () => ({ handleFetchCore: vi.fn() }));
vi.mock("open-sse/handlers/systemoneCore.js", () => ({ handleSystemoneCore: vi.fn() }));
vi.mock("open-sse/services/combo.js", () => ({
  handleComboChat: vi.fn(), handleFusionChat: vi.fn(), detectRequiredCapabilities: () => new Set(),
  getComboModelsFromData: vi.fn(),
}));
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "http://headroom.test" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn() }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("@/sse/services/antigravityQuota.js", () => ({ handleAntigravityQuotaError: vi.fn(), clearAntigravityStrikes: vi.fn() }));
vi.mock("open-sse/services/projectId.js", () => ({ getProjectIdForConnection: vi.fn() }));
vi.mock("@/sse/services/claudeBuiltinSearch.js", () => ({ enrichClaudeBuiltinSearch: vi.fn() }));

import { handleChat } from "@/sse/handlers/chat.js";
import { handleEmbeddings } from "@/sse/handlers/embeddings.js";
import { handleTts } from "@/sse/handlers/tts.js";
import { handleImageGeneration } from "@/sse/handlers/imageGeneration.js";
import { handleSearch } from "@/sse/handlers/search.js";
import { handleFetch } from "@/sse/handlers/fetch.js";
import { handleSystemone } from "@/sse/handlers/systemone.js";

const handlers = { chat: handleChat, embeddings: handleEmbeddings, tts: handleTts,
  image: handleImageGeneration, search: handleSearch, fetch: handleFetch, systemone: handleSystemone };
const request = (raw) => new Request("http://router.test/v1/test", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: raw,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings.mockResolvedValue({});
  mocks.comboModels.mockResolvedValue(null);
  mocks.modelInfo.mockResolvedValue({ provider: null });
  mocks.saveUsage.mockResolvedValue(undefined);
});

describe.each(Object.entries(handlers))("%s JSON ingress", (_, handle) => {
  it.each(["null", "[]", '"text"', "42", "true"])("rejects non-object JSON %s before settings or routing", async (raw) => {
    const response = await handle(request(raw));
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe("Request body must be an object");
    expect(mocks.settings).not.toHaveBeenCalled();
    expect(mocks.modelInfo).not.toHaveBeenCalled();
    expect(mocks.credentials).not.toHaveBeenCalled();
  });

  it("returns a JSON error for malformed JSON", async () => {
    const response = await handle(request("{"));
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe("Invalid JSON body");
    expect(mocks.settings).not.toHaveBeenCalled();
  });

  it("accepts an object and reports its missing required fields", async () => {
    const response = await handle(request("{}"));
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toMatch(/Missing/);
    expect(mocks.settings).toHaveBeenCalledOnce();
  });
});

describe.each(Object.entries({ chat: handleChat, embeddings: handleEmbeddings, tts: handleTts, image: handleImageGeneration }))(
  "%s model validation", (_, handle) => {
    it.each([123, {}, [], true, "   "].map(model => ({ model })))("rejects model $model before model resolution", async ({ model }) => {
      const response = await handle(request(JSON.stringify({ model, input: "hello", prompt: "hello" })));
      expect(response.status).toBe(400);
      expect((await response.json()).error.message).toBe("Missing model");
      expect(mocks.modelInfo).not.toHaveBeenCalled();
      expect(mocks.comboModels).not.toHaveBeenCalled();
    });
  }
);

describe("modality inputs", () => {
  it.each([123, {}, [], true, "   "].map(input => ({ input })))("rejects TTS input $input without invoking synthesis", async ({ input }) => {
    const response = await handleTts(request(JSON.stringify({ model: "google-tts/en", input })));
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe("Missing required field: input");
    expect(mocks.tts).not.toHaveBeenCalled();
    expect(mocks.modelInfo).not.toHaveBeenCalled();
  });

  it.each(["hello", ["hello", "world"], [12, 34], [[12], [34]]].map(input => ({ input })))("preserves supported embeddings input $input", async ({ input }) => {
    mocks.modelInfo.mockResolvedValue({ provider: "openai", model: "text-embedding-3-small" });
    mocks.credentials.mockResolvedValue({ connectionId: "test", apiKey: "test" });
    mocks.embeddings.mockResolvedValue({ success: true, response: Response.json({ data: [{ embedding: [0.1] }] }) });
    const response = await handleEmbeddings(request(JSON.stringify({ model: "openai/text-embedding-3-small", input })));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [{ embedding: [0.1] }] });
    expect(mocks.embeddings).toHaveBeenCalledWith(expect.objectContaining({ body: { model: "openai/text-embedding-3-small", input } }));
  });
});
