// A request whose translation fails ends before it is counted as pending, so it
// must not end a pending count either: that would take one off another request
// still in flight on the same account and model.
import { beforeAll, beforeEach, expect, it, vi } from "vitest";

const { trackPendingMock, executeMock } = vi.hoisted(() => ({
  trackPendingMock: vi.fn(),
  executeMock: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(() => ({ execute: executeMock, noAuth: true })),
}));
vi.mock("../../open-sse/translator/index.js", async (importOriginal) => ({
  ...(await importOriginal()),
  translateRequest: vi.fn(() => null),
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn(async () => ({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(), logError: vi.fn(),
  })),
}));
vi.mock("../../open-sse/translator/concerns/prefetch.js", () => ({
  prefetchRemoteImages: vi.fn(async () => 0),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: trackPendingMock,
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
  saveRequestUsage: vi.fn(() => Promise.resolve()),
}));

let handleChatCore;

beforeAll(async () => {
  ({ handleChatCore } = await import("../../open-sse/handlers/chatCore.js"));
}, 30000);

beforeEach(() => {
  trackPendingMock.mockClear();
  executeMock.mockReset();
});

it("a request that fails translation never touches the pending count", async () => {
  const body = { model: "gpt-4o", stream: false, messages: [{ role: "user", content: "Hi" }] };
  const result = await handleChatCore({
    body,
    modelInfo: { provider: "openai", model: "gpt-4o" },
    credentials: { apiKey: "k", providerSpecificData: {} },
    clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: {} },
    connectionId: "conn-1",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });

  expect(result).toMatchObject({ success: false, status: 400 });
  expect(executeMock).not.toHaveBeenCalled();
  expect(trackPendingMock).not.toHaveBeenCalled();
});
