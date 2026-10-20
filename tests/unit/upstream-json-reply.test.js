// A client that leaves `stream` out is answered as a stream, but some upstreams
// (Anthropic-style APIs, Snowflake Cortex) answer that same request with plain
// JSON. That JSON must come back as JSON, not JSON plus a stray "data: [DONE]".
import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(() => ({
    execute: executeMock,
    refreshCredentials: vi.fn().mockResolvedValue(null),
  })),
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
}));

vi.mock("../../open-sse/utils/toolDeduper.js", () => ({
  dedupeTools: vi.fn((tools) => ({ tools, stripped: [] })),
}));

vi.mock("../../open-sse/rtk/caveman.js", () => ({
  injectCaveman: vi.fn(),
}));

vi.mock("../../open-sse/rtk/ponytail.js", () => ({
  injectPonytail: vi.fn(),
}));

vi.mock("../../open-sse/rtk/index.js", () => ({
  compressMessages: vi.fn(() => null),
  formatRtkLog: vi.fn(() => ""),
}));

vi.mock("../../open-sse/rtk/headroom.js", () => ({
  compressWithHeadroom: vi.fn(async () => null),
  formatHeadroomLog: vi.fn(() => ""),
  formatHeadroomSizeLog: vi.fn(() => ""),
}));

vi.mock("../../open-sse/providers/capabilities.js", () => ({
  getCapabilitiesForModel: vi.fn(() => ({})),
}));

vi.mock("../../open-sse/translator/concerns/modality.js", () => ({
  stripUnsupportedModalities: vi.fn(() => false),
}));

vi.mock("../../open-sse/translator/concerns/prefetch.js", () => ({
  prefetchRemoteImages: vi.fn(async () => 0),
}));

vi.mock("../../open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: vi.fn((detail) => detail),
  extractRequestConfig: vi.fn((body, stream) => ({ body, stream })),
}));

vi.mock("../../open-sse/handlers/chatCore/nonStreamingHandler.js", () => ({
  handleNonStreamingResponse: vi.fn(async () => ({ success: true, response: new Response("{}", { headers: { "content-type": "application/json" } }) })),
}));

vi.mock("../../open-sse/handlers/chatCore/streamingHandler.js", () => ({
  handleStreamingResponse: vi.fn(async () => ({ success: true, response: new Response("data: x\n\n") })),
  buildOnStreamComplete: vi.fn(() => ({ onStreamComplete: vi.fn(), streamDetailId: null })),
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


const opts = () => {
  const body = { model: "claude-haiku-4-5", messages: [{ role: "user", content: "hi" }] };
  return {
    body,
    modelInfo: { provider: "deepseek", model: "deepseek-chat" },
    credentials: { apiKey: "sk-test" },
    clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: {} },
    connectionId: "c1",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
};
const upstream = (type) => ({ response: new Response("{}", { status: 200, headers: { "content-type": type } }), url: "https://x/v1", headers: {}, transformedBody: {} });

describe("upstream answers a stream request with JSON", () => {
  beforeEach(() => executeMock.mockReset());

  it("reads a JSON reply as non-streaming", async () => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    const { handleNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
    const { handleStreamingResponse } = await import("../../open-sse/handlers/chatCore/streamingHandler.js");
    executeMock.mockResolvedValue(upstream("application/json; charset=utf-8"));
    await handleChatCore(opts());
    expect(executeMock.mock.calls[0][0].stream).toBe(true);
    expect(handleNonStreamingResponse).toHaveBeenCalledTimes(1);
    expect(handleStreamingResponse).not.toHaveBeenCalled();
  });

  it("still streams an SSE reply", async () => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    const { handleNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
    const { handleStreamingResponse } = await import("../../open-sse/handlers/chatCore/streamingHandler.js");
    vi.mocked(handleNonStreamingResponse).mockClear(); vi.mocked(handleStreamingResponse).mockClear();
    executeMock.mockResolvedValue(upstream("text/event-stream"));
    await handleChatCore(opts());
    expect(handleStreamingResponse).toHaveBeenCalledTimes(1);
    expect(handleNonStreamingResponse).not.toHaveBeenCalled();
  });
});
