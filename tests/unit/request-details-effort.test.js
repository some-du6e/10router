/**
 * Request details store the client's request as the client sent it. The router
 * may add its own reasoning effort (a provider thinking override, a "(level)"
 * model suffix) and, on a same-format route, edits the body in place; that
 * belongs in the provider request only.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock, saveRequestDetailMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  saveRequestDetailMock: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(() => ({ execute: executeMock, noAuth: true })),
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn(async () => ({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(), logError: vi.fn(),
    logConvertedResponse: vi.fn(), logProviderResponse: vi.fn(),
  })),
}));
vi.mock("../../open-sse/utils/streamHandler.js", async (importOriginal) => ({
  ...(await importOriginal()),
  createStreamController: vi.fn(() => ({
    signal: undefined, isConnected: () => true,
    handleComplete: vi.fn(), handleError: vi.fn(), handleDisconnect: vi.fn(), abort: vi.fn(),
  })),
}));
vi.mock("../../open-sse/translator/concerns/prefetch.js", () => ({
  prefetchRemoteImages: vi.fn(async () => 0),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: saveRequestDetailMock,
  saveRequestUsage: vi.fn(() => Promise.resolve()),
}));

let handleChatCore;

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function run({ model, extraBody = {}, providerThinking, stream = false } = {}) {
  const body = { model, stream, messages: [{ role: "user", content: "Hi" }], ...extraBody };
  return handleChatCore({
    body,
    modelInfo: { provider: "openai", model },
    credentials: { apiKey: "k", providerSpecificData: {} },
    clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: {} },
    connectionId: "conn-1",
    providerThinking,
    log,
  });
}

const JSON_REPLY = { id: "chatcmpl-1", object: "chat.completion", model: "gpt-5-x", choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } };
const SSE_REPLY = [
  `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: "gpt-5-x", choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }] })}`,
  `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: "gpt-5-x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } })}`,
  "data: [DONE]",
  "",
].join("\n\n");

// The upstream answers with `status` (SSE when `sse`); the row's providerRequest is the body the executor got.
function respond(status, { sse = false } = {}) {
  executeMock.mockImplementation(async ({ body }) => {
    const response = sse
      ? new Response(SSE_REPLY, { status, headers: { "content-type": "text/event-stream" } })
      : new Response(JSON.stringify(status === 200 ? JSON_REPLY : { error: { message: "bad request" } }), { status, headers: { "content-type": "application/json" } });
    return { response, url: "https://upstream.example.test", headers: {}, transformedBody: body };
  });
}

const rows = () => saveRequestDetailMock.mock.calls.map((c) => c[0]);
const savedRow = (status) => rows().find((d) => d.status === status);
const sentBody = (call = 0) => executeMock.mock.calls[call][0].body;

describe("request details keep the client's reasoning effort, not the router's", () => {
  beforeAll(async () => {
    ({ handleChatCore } = await import("../../open-sse/handlers/chatCore.js"));
  }, 30000);

  beforeEach(() => {
    executeMock.mockReset();
    saveRequestDetailMock.mockClear();
  });

  it("leaves a provider thinking override out of the client request", async () => {
    respond(400);
    await run({ model: "gpt-5-x", providerThinking: { mode: "high" } });
    expect(sentBody().reasoning_effort).toBeTruthy();
    const row = savedRow("error");
    expect(row.request).not.toHaveProperty("reasoning_effort");
    expect(row.providerRequest.reasoning_effort).toBe(sentBody().reasoning_effort);
  });

  it("keeps the client's effort when a model suffix overrides it on a same-format route", async () => {
    respond(400);
    await run({ model: "gpt-5-x(max)", extraBody: { reasoning_effort: "low" } });
    expect(sentBody().reasoning_effort).toBeTruthy();
    expect(sentBody().reasoning_effort).not.toBe("low");
    const row = savedRow("error");
    expect(row.request.reasoning_effort).toBe("low");
    expect(row.providerRequest.reasoning_effort).toBe(sentBody().reasoning_effort);
  });

  it("records the client's effort on a successful reply too", async () => {
    respond(200);
    await run({ model: "gpt-5-x(max)", extraBody: { reasoning_effort: "low" } });
    expect(sentBody().reasoning_effort).not.toBe("low");
    const row = savedRow("success");
    expect(row.request.reasoning_effort).toBe("low");
    expect(row.providerRequest.reasoning_effort).toBe(sentBody().reasoning_effort);
  });

  it("records the client's effort on a streamed reply", async () => {
    respond(200, { sse: true });
    const result = await run({ model: "gpt-5-x(max)", stream: true, extraBody: { reasoning_effort: "low" } });
    expect(sentBody().reasoning_effort).not.toBe("low");
    const row = savedRow("success");
    expect(row.response.type).toBe("streaming");
    expect(row.request.reasoning_effort).toBe("low");
    expect(row.request.stream).toBe(true);
    expect(row.providerRequest.reasoning_effort).toBe(sentBody().reasoning_effort);
    await result.response?.body?.cancel().catch(() => {});
  });

  it("records the client's effort when an SSE reply is turned into JSON", async () => {
    respond(200, { sse: true });
    await run({ model: "gpt-5-x(max)", extraBody: { reasoning_effort: "low" } });
    const row = savedRow("success");
    expect(row.response.content).toBe("Hello");
    expect(row.request.reasoning_effort).toBe("low");
    expect(row.providerRequest.reasoning_effort).not.toBe("low");
  });

  it("records the client's effort when the executor throws", async () => {
    executeMock.mockRejectedValue(new Error("fetch failed"));
    await run({ model: "gpt-5-x(max)", extraBody: { reasoning_effort: "low" } });
    const row = savedRow("error");
    expect(row.response.status).toBe(502);
    expect(row.request.reasoning_effort).toBe("low");
    expect(row.providerRequest.reasoning_effort).toBeTruthy();
    expect(row.providerRequest.reasoning_effort).not.toBe("low");
  });

  // The account loop hands each attempt a shallow copy of one client body, so a
  // nested edit on the first attempt would reach the second.
  it("keeps the client's output_config for the next attempt after a Claude passthrough strips effort", async () => {
    respond(400);
    const clientBody = {
      model: "claude-x", max_tokens: 1024, stream: false,
      messages: [{ role: "user", content: "Hi" }],
      thinking: { type: "adaptive" }, output_config: { effort: "low" },
    };
    const attempt = (model) => {
      const body = { ...clientBody, model };
      return handleChatCore({
        body,
        modelInfo: { provider: "anthropic", model },
        credentials: { apiKey: "k", providerSpecificData: {} },
        clientRawRequest: { endpoint: "/v1/messages", body, headers: { "user-agent": "claude-cli/2.0.0" } },
        connectionId: "conn-1",
        sourceFormatOverride: "claude",
        log,
      });
    };

    // A haiku model doesn't take effort, so the passthrough drops it from what's sent.
    await attempt("claude-haiku-4-x");
    expect(sentBody(0).output_config?.effort).toBeUndefined();
    expect(clientBody.output_config).toEqual({ effort: "low" });

    await attempt("claude-sonnet-5-x");
    const second = rows()[1];
    expect(second.request.output_config).toEqual({ effort: "low" });
    expect(sentBody(1).output_config).toEqual({ effort: "low" });
  });
});
