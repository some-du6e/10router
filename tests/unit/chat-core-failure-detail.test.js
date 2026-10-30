/**
 * chatCore failure rows in requestDetails: they carry an errorClass and, when the
 * upstream answered, a real ttft (time until response headers) instead of 0.
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

const UPSTREAM_DELAY_MS = 40;

let handleChatCore;

function run() {
  const body = { model: "gpt-4o", stream: false, messages: [{ role: "user", content: "Hi" }] };
  return handleChatCore({
    body,
    modelInfo: { provider: "openai", model: "gpt-4o" },
    credentials: { apiKey: "k", providerSpecificData: {} },
    clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: {} },
    connectionId: "conn-1",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
}

function respondAfterDelay(status, payload) {
  executeMock.mockImplementation(async () => {
    await new Promise((r) => setTimeout(r, UPSTREAM_DELAY_MS));
    return {
      response: new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } }),
      url: "https://upstream.example.test", headers: {}, transformedBody: {},
    };
  });
}

const savedErrorRow = () => saveRequestDetailMock.mock.calls.map((c) => c[0]).find((d) => d.status === "error");

describe("chatCore failure request details", () => {
  // Cold import of chatCore pulls the whole engine; keep it out of the per-test budget.
  beforeAll(async () => {
    ({ handleChatCore } = await import("../../open-sse/handlers/chatCore.js"));
  }, 30000);

  beforeEach(() => {
    executeMock.mockReset();
    saveRequestDetailMock.mockClear();
  });

  it("records rate_limited and the time to upstream headers on a 429", async () => {
    respondAfterDelay(429, { error: { type: "rate_limit_error", message: "Too many requests" } });
    await run();
    const row = savedErrorRow();
    expect(row.errorClass).toBe("rate_limited");
    expect(row.latency.ttft).toBeGreaterThanOrEqual(UPSTREAM_DELAY_MS - 5);
    expect(row.latency.ttft).toBeLessThanOrEqual(row.latency.total);
    expect(row.response.status).toBe(429);
  });

  it("records upstream_5xx on a 503", async () => {
    respondAfterDelay(503, { error: { code: "service_unavailable", message: "temporarily unavailable" } });
    await run();
    expect(savedErrorRow().errorClass).toBe("upstream_5xx");
  });

  it("records auth_error on a 401", async () => {
    respondAfterDelay(401, { error: { message: "invalid api key" } });
    await run();
    expect(savedErrorRow().errorClass).toBe("auth_error");
  });

  it("records timeout with ttft 0 when the upstream never answered", async () => {
    executeMock.mockRejectedValue(new Error("fetch connect timeout"));
    await run();
    const row = savedErrorRow();
    expect(row.errorClass).toBe("timeout");
    expect(row.latency.ttft).toBe(0);
    expect(row.response.status).toBe(502);
  });

  it("records timeout when undici reports it only in the error cause", async () => {
    const cause = Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" });
    executeMock.mockRejectedValue(new TypeError("fetch failed", { cause }));
    await run();
    expect(savedErrorRow().errorClass).toBe("timeout");
  });

  it("records rate_limited, not auth_error, for a quota error sent as 403", async () => {
    respondAfterDelay(403, { error: { message: "You exceeded your current quota" } });
    await run();
    expect(savedErrorRow().errorClass).toBe("rate_limited");
  });
});
