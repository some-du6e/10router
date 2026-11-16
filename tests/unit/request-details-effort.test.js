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
vi.mock("../../open-sse/utils/streamHandler.js", () => ({
  createStreamController: vi.fn(() => ({ signal: undefined, handleComplete: vi.fn(), handleError: vi.fn() })),
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

function run({ model, extraBody = {}, providerThinking } = {}) {
  const body = { model, stream: false, messages: [{ role: "user", content: "Hi" }], ...extraBody };
  return handleChatCore({
    body,
    modelInfo: { provider: "openai", model },
    credentials: { apiKey: "k", providerSpecificData: {} },
    clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: {} },
    connectionId: "conn-1",
    providerThinking,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
}

// The upstream answers with `status`; the row's providerRequest is the body the executor got.
function respond(status) {
  executeMock.mockImplementation(async ({ body }) => {
    const payload = status === 200
      ? { id: "chatcmpl-1", object: "chat.completion", model: "gpt-5-x", choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } }
      : { error: { message: "bad request" } };
    return {
      response: new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } }),
      url: "https://upstream.example.test", headers: {}, transformedBody: body,
    };
  });
}

const savedRow = (status) => saveRequestDetailMock.mock.calls.map((c) => c[0]).find((d) => d.status === status);
const sentBody = () => executeMock.mock.calls[0][0].body;

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
});
