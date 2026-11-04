// handleChatCore's clientSignal: a client that hangs up aborts this attempt's
// upstream call while it waits on headers, ends a returned stream as a
// disconnect, and a finished attempt takes its listener off the signal every
// attempt of the request shares. The dashboard's pending count goes up once
// and down once whichever way it ends.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock, trackPendingMock } = vi.hoisted(() => ({ executeMock: vi.fn(), trackPendingMock: vi.fn() }));

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
  trackPendingRequest: trackPendingMock,
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
  saveRequestUsage: vi.fn(() => Promise.resolve()),
}));

let handleChatCore;

function run(clientSignal, { stream = false, provider = "openai" } = {}) {
  const body = { model: "gpt-4o", stream, messages: [{ role: "user", content: "Hi" }] };
  return handleChatCore({
    body,
    modelInfo: { provider, model: "gpt-4o" },
    credentials: { apiKey: "k", providerSpecificData: {} },
    clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: {} },
    connectionId: "conn-1",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    clientSignal,
  });
}

// An upstream that answers after `ms`, or rejects like fetch once its signal
// aborts. `response` gets the signal, so a body can error on abort like fetch's.
function upstream(response, ms = 50) {
  executeMock.mockImplementation(({ signal } = {}) => new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(t); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve({ response: response(signal), url: "https://upstream.example.test", headers: {}, transformedBody: {} });
    }, ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  }));
}
const failed = () => new Response(JSON.stringify({ error: { message: "down" } }), { status: 503, headers: { "content-type": "application/json" } });
// One chunk, then open until the upstream signal aborts it.
const streaming = (signal) => new Response(new ReadableStream({
  start(c) {
    c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
    signal?.addEventListener("abort", () => c.error(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
  },
}), { headers: { "content-type": "text/event-stream" } });

const pendingCalls = () => trackPendingMock.mock.calls.map((c) => c[3]);

describe("handleChatCore clientSignal", () => {
  beforeAll(async () => {
    ({ handleChatCore } = await import("../../open-sse/handlers/chatCore.js"));
  }, 30000);
  beforeEach(() => { executeMock.mockReset(); trackPendingMock.mockClear(); });

  it("an already-aborted signal aborts the upstream call before it starts", async () => {
    upstream(failed);
    const client = new AbortController();
    client.abort();
    const result = await run(client.signal);
    expect(executeMock.mock.calls[0][0].signal.aborted).toBe(true);
    expect(result.status).toBe(499);
    expect(pendingCalls()).toEqual([true, false]);
  });

  it("a hang-up during the upstream wait aborts the upstream call; pending goes down once", async () => {
    upstream(failed, 5_000);
    const client = new AbortController();
    const pending = run(client.signal);
    await vi.waitFor(() => expect(executeMock).toHaveBeenCalled());
    const { signal } = executeMock.mock.calls[0][0];
    expect(signal.aborted).toBe(false);
    client.abort();
    expect(signal.aborted).toBe(true);
    expect((await pending).status).toBe(499);
    expect(pendingCalls()).toEqual([true, false]);
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

  it("a hang-up while a non-stream request reads an SSE body is a quiet 499, not a throw", async () => {
    // Half an event, then open until the upstream signal aborts it.
    upstream((signal) => new Response(new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"h'));
        signal?.addEventListener("abort", () => c.error(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      },
    }), { headers: { "content-type": "text/event-stream" } }));
    const client = new AbortController();
    // groq is not forceStream, so the reply goes through the plain non-stream handler.
    const pending = run(client.signal, { stream: false, provider: "groq" });
    await vi.waitFor(() => expect(executeMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 100));
    client.abort();
    const result = await pending;
    expect(result).toMatchObject({ success: false, status: 499 });
  });

  it("a hang-up mid-stream is a disconnect: upstream dropped, pending down exactly once", async () => {
    upstream(streaming);
    const client = new AbortController();
    const remove = vi.spyOn(client.signal, "removeEventListener");
    const result = await run(client.signal, { stream: true });
    expect(result.success).toBe(true);
    expect(remove).not.toHaveBeenCalled();
    const reader = result.response.body.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("hi");

    // Next aborts request.signal before the body cancel arrives.
    client.abort();
    expect(pendingCalls()).toEqual([true, false]);
    await reader.cancel();
    const { signal } = executeMock.mock.calls[0][0];
    await vi.waitFor(() => expect(signal.aborted).toBe(true), { timeout: 2000 });
    expect(pendingCalls()).toEqual([true, false]);
  });
});
