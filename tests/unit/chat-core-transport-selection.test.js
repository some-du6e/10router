/**
 * Tests chatCore's selection of a source-matched transport, a model's target
 * transport, or the provider default. Translation and execution are mocked;
 * these checks do not validate translated payloads or upstream responses.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  executeMock,
  translateRequestMock,
  handleNonStreamingResponseMock,
} = vi.hoisted(() => ({
  executeMock: vi.fn(),
  translateRequestMock: vi.fn((sourceFormat, targetFormat, model, body) => ({
    ...body,
    model,
    _translatedFrom: sourceFormat,
    _translatedTo: targetFormat,
  })),
  handleNonStreamingResponseMock: vi.fn(async () => ({ success: true })),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(() => ({
    execute: executeMock,
    refreshCredentials: vi.fn().mockResolvedValue(null),
  })),
}));

vi.mock("../../open-sse/translator/index.js", () => ({
  translateRequest: translateRequestMock,
}));

vi.mock("../../open-sse/handlers/chatCore/nonStreamingHandler.js", () => ({
  handleNonStreamingResponse: handleNonStreamingResponseMock,
}));

vi.mock("../../open-sse/handlers/chatCore/streamingHandler.js", () => ({
  buildOnStreamComplete: vi.fn(() => vi.fn()),
  handleStreamingResponse: vi.fn(async () => ({ success: true })),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn(async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logError: vi.fn(),
  })),
}));

vi.mock("../../open-sse/utils/clientDetector.js", () => ({
  detectClientTool: vi.fn(() => null),
  isNativePassthrough: vi.fn(() => false),
}));

vi.mock("../../open-sse/utils/bypassHandler.js", () => ({
  handleBypassRequest: vi.fn(() => null),
}));

vi.mock("../../open-sse/utils/streamHandler.js", () => ({
  createStreamController: vi.fn(() => ({
    signal: undefined,
    handleComplete: vi.fn(),
    handleError: vi.fn(),
  })),
}));

vi.mock("../../open-sse/services/tokenRefresh.js", () => ({
  refreshWithRetry: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  default: vi.fn(),
  proxyAwareFetch: vi.fn(),
}));

vi.mock("../../open-sse/translator/formats/claude.js", () => ({
  normalizeClaudePassthrough: vi.fn(),
  anchorClaudeCache: vi.fn(),
}));

vi.mock("../../open-sse/utils/toolDeduper.js", () => ({
  dedupeTools: vi.fn((tools) => ({ tools, stripped: [] })),
}));

vi.mock("../../open-sse/rtk/caveman.js", () => ({ injectCaveman: vi.fn() }));
vi.mock("../../open-sse/rtk/ponytail.js", () => ({ injectPonytail: vi.fn() }));
vi.mock("../../open-sse/rtk/index.js", () => ({
  compressMessages: vi.fn(() => null),
  formatRtkLog: vi.fn(() => ""),
}));
vi.mock("../../open-sse/rtk/headroom.js", () => ({
  compressWithHeadroom: vi.fn(async () => null),
  formatHeadroomLog: vi.fn(() => ""),
  formatHeadroomSizeLog: vi.fn(() => ""),
  isHeadroomPhantomSavings: vi.fn(() => false),
}));
vi.mock("../../open-sse/rtk/pxpipe.js", () => ({
  compressWithPxpipe: vi.fn(async () => ({ body: null, summary: null })),
}));

vi.mock("../../open-sse/translator/concerns/prefetch.js", () => ({
  prefetchRemoteImages: vi.fn(async () => 0),
}));

vi.mock("../../open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: vi.fn((detail) => detail),
  extractRequestConfig: vi.fn((body, stream) => ({ body, stream })),
}));

vi.mock("../../open-sse/utils/error.js", () => ({
  createErrorResult: vi.fn((status, message) => ({ success: false, status, error: message })),
  formatProviderError: vi.fn((error) => error.message),
  parseUpstreamError: vi.fn(),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
}));

function makeOptions(body, provider, model) {
  return {
    body,
    modelInfo: { provider, model },
    credentials: { apiKey: "test-api-key", providerSpecificData: {} },
    clientRawRequest: {
      endpoint: "/v1/chat/completions",
      body,
      headers: { accept: "application/json" },
    },
    connectionId: "test-connection",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

describe("chatCore transport selection", () => {
  beforeEach(() => {
    executeMock.mockReset();
    translateRequestMock.mockClear();
    handleNonStreamingResponseMock.mockClear();
    executeMock.mockResolvedValue({
      response: new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      url: "https://upstream.example.test/mock",
      headers: {},
      transformedBody: {},
    });
  });

  it.each(["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"])("routes %s chat requests to Responses", async (model) => {
    const body = { model, stream: false, messages: [{ role: "user", content: "Hello" }] };
    const options = makeOptions(body, "openai", model);
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    await handleChatCore(options);

    expect(executeMock).toHaveBeenCalledTimes(1);
    const request = executeMock.mock.calls[0][0];
    expect(request.body._translatedTo).toBe("openai-responses");
    expect(request.credentials.runtimeTransport.baseUrl).toBe("https://api.openai.com/v1/responses");
  });

  it("keeps GPT-4o chat requests on the default transport", async () => {
    const body = { model: "gpt-4o", stream: false, messages: [{ role: "user", content: "Hello" }] };
    const options = makeOptions(body, "openai", "gpt-4o");
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    await handleChatCore(options);

    const request = executeMock.mock.calls[0][0];
    expect(request.body._translatedTo).toBe("openai");
    expect(request.credentials.runtimeTransport).toBeUndefined();
  });

  // Regression: https://github.com/decolua/9router/issues/3418
  it("prefers MiniMax-M3's matching OpenAI transport over its Claude target", async () => {
    const imageBlock = {
      type: "image_url",
      image_url: { url: "data:image/png;base64,AAAB" },
    };
    const body = {
      model: "minimax-cn/MiniMax-M3",
      stream: false,
      messages: [{
        role: "user",
        content: [{ type: "text", text: "Describe this image" }, imageBlock],
      }],
    };

    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    await handleChatCore(makeOptions(body, "minimax-cn", "MiniMax-M3"));

    expect(translateRequestMock).toHaveBeenCalledWith(
      "openai",
      "openai",
      "MiniMax-M3",
      expect.any(Object),
      false,
      expect.any(Object),
      "minimax-cn",
      expect.any(Object),
      expect.anything(),
      "test-connection",
      null,
    );
    expect(executeMock).toHaveBeenCalledTimes(1);
    const requestBody = executeMock.mock.calls[0][0].body;
    expect(requestBody.messages[0].content).toContainEqual(imageBlock);
    expect(requestBody._translatedTo).toBe("openai");
    expect(requestBody).not.toHaveProperty("system");
    expect(executeMock.mock.calls[0][0].credentials.runtimeTransport.format).toBe("openai");
  });
});
