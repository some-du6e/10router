// A cut-short stream's floor starts when a read-ahead executor got its
// response: kiro stamps it, and the streaming handler hands it to the stream.
import { describe, expect, it, vi } from "vitest";

describe("the floor's start time reaches the stream", () => {
  it("kiro stamps when its fetch returned", async () => {
    const { BaseExecutor } = await import("open-sse/executors/base.js");
    const { KiroExecutor } = await import("open-sse/executors/kiro.js");
    const spy = vi.spyOn(BaseExecutor.prototype, "execute").mockResolvedValue({ response: new Response("", { status: 200 }) });
    const gate = vi.spyOn(KiroExecutor.prototype, "attachIntegrityGate").mockImplementation(() => {});
    try {
      const before = Date.now();
      const result = await new KiroExecutor().execute({ body: {}, model: "claude-x", stream: true, credentials: {} });
      expect(result.response.upstreamStartedAt).toBeGreaterThanOrEqual(before);
      expect(result.response.upstreamStartedAt).toBeLessThanOrEqual(Date.now());
    } finally {
      spy.mockRestore();
      gate.mockRestore();
    }
  });

  it("handleStreamingResponse copies upstreamStartedAt and the sent body onto the stream", async () => {
    vi.resetModules();
    let seen = null;
    vi.doMock("open-sse/utils/streamHandler.js", async (orig) => ({
      ...(await orig()),
      pipeWithDisconnect: (_res, ts) => { seen = ts; return new ReadableStream(); },
    }));
    vi.doMock("@/lib/usageDb.js", () => ({
      saveRequestDetail: vi.fn(() => Promise.resolve()), saveRequestUsage: vi.fn(() => Promise.resolve()),
      appendRequestLog: vi.fn(() => Promise.resolve()), trackPendingRequest: vi.fn(),
    }));
    const { handleStreamingResponse, buildOnStreamComplete } = await import("open-sse/handlers/chatCore/streamingHandler.js");
    const body = { model: "claude-x", stream: true, messages: [{ role: "user", content: "hi" }], max_tokens: 1 };
    const translatedBody = { ...body, max_tokens: 64000 };
    const ctx = { provider: "anthropic", model: "claude-x", body, stream: true, translatedBody, requestStartTime: Date.now() };
    const { onStreamComplete, streamDetailId, streamRequest } = buildOnStreamComplete(ctx);
    const providerResponse = new Response("", { headers: { "content-type": "text/event-stream" } });
    providerResponse.upstreamStartedAt = 12345;
    const controller = { signal: new AbortController().signal, isConnected: () => true, handleComplete: vi.fn(), handleError: vi.fn(), handleDisconnect: vi.fn() };
    await handleStreamingResponse({ ...ctx, providerResponse, sourceFormat: "claude", targetFormat: "claude", streamController: controller, onStreamComplete, streamDetailId, streamRequest });
    expect(seen?.upstreamStartedAt).toBe(12345);
    expect(seen?.upstreamBody?.max_tokens).toBe(64000);
    vi.doUnmock("open-sse/utils/streamHandler.js");
    vi.doUnmock("@/lib/usageDb.js");
  });
});
