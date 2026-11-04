// handleChatCore's clientSignal: a client that hangs up aborts this attempt's
// upstream call, and a finished attempt takes its listener off the signal every
// attempt of the request shares.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(() => ({ execute: executeMock, noAuth: true })),
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
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
  saveRequestUsage: vi.fn(() => Promise.resolve()),
}));

let handleChatCore;

function run(clientSignal, { stream = false } = {}) {
  const body = { model: "gpt-4o", stream, messages: [{ role: "user", content: "Hi" }] };
  return handleChatCore({
    body,
    modelInfo: { provider: "openai", model: "gpt-4o" },
    credentials: { apiKey: "k", providerSpecificData: {} },
    clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: {} },
    connectionId: "conn-1",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    clientSignal,
  });
}

// An upstream that answers after `ms`, or rejects like fetch once its signal aborts.
function upstream(response, ms = 50) {
  executeMock.mockImplementation(({ signal } = {}) => new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(t); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); };
    const t = setTimeout(() => resolve({ response: response(), url: "https://upstream.example.test", headers: {}, transformedBody: {} }), ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  }));
}
const failed = () => new Response(JSON.stringify({ error: { message: "down" } }), { status: 503, headers: { "content-type": "application/json" } });
const streamed = () => new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });

describe("handleChatCore clientSignal", () => {
  beforeAll(async () => {
    ({ handleChatCore } = await import("../../open-sse/handlers/chatCore.js"));
  }, 30000);
  beforeEach(() => executeMock.mockReset());

  it("an already-aborted signal aborts the upstream call before it starts", async () => {
    upstream(failed);
    const client = new AbortController();
    client.abort();
    const result = await run(client.signal);
    expect(executeMock.mock.calls[0][0].signal.aborted).toBe(true);
    expect(result.status).toBe(499);
  });

  it("a hang-up during the upstream wait aborts the upstream call", async () => {
    upstream(failed, 5_000);
    const client = new AbortController();
    const pending = run(client.signal);
    await vi.waitFor(() => expect(executeMock).toHaveBeenCalled());
    const { signal } = executeMock.mock.calls[0][0];
    expect(signal.aborted).toBe(false);
    client.abort();
    expect(signal.aborted).toBe(true);
    expect((await pending).status).toBe(499);
  });

  it("a failed attempt takes its listener off the shared signal", async () => {
    upstream(failed);
    const client = new AbortController();
    const add = vi.spyOn(client.signal, "addEventListener");
    const remove = vi.spyOn(client.signal, "removeEventListener");
    const result = await run(client.signal);
    expect(result.success).toBe(false);
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0][1]);
  });

  it("a streaming attempt keeps its listener, so a later hang-up still aborts it", async () => {
    upstream(streamed);
    const client = new AbortController();
    const remove = vi.spyOn(client.signal, "removeEventListener");
    const result = await run(client.signal, { stream: true });
    expect(result.success).toBe(true);
    expect(remove).not.toHaveBeenCalled();
    const { signal } = executeMock.mock.calls[0][0];
    client.abort();
    expect(signal.aborted).toBe(true);
    await result.response.body.cancel();
  });
});
