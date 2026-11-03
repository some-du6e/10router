// Cloudflare drops a proxied stream after ~100s with no bytes. While upstream is
// quiet, 10router writes SSE comments to the client so the connection survives.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { pipeWithDisconnect } from "../../open-sse/utils/streamHandler.js";
import { SSE_KEEPALIVE } from "../../open-sse/utils/sseConstants.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const KEEPALIVE = 15_000;
const STALL = 360_000;

function makeController() {
  let connected = true;
  return {
    signal: new AbortController().signal,
    startTime: Date.now(),
    isConnected: () => connected,
    handleComplete: vi.fn(() => { connected = false; }),
    handleError: vi.fn(() => { connected = false; }),
    handleDisconnect: vi.fn(() => { connected = false; }),
    abort: vi.fn(),
  };
}

// An upstream body the test drives by hand. abort() errors it, like fetch does.
function makeUpstream() {
  let ctrl;
  const body = new ReadableStream({ start(c) { ctrl = c; } });
  return {
    response: { body },
    send: (text) => ctrl.enqueue(enc.encode(text)),
    end: () => ctrl.close(),
    fail: (err) => ctrl.error(err),
  };
}

function pipe(upstream, controller, { keepaliveMs = KEEPALIVE, stallMs = STALL, onAbortTerminal = null } = {}) {
  const out = pipeWithDisconnect(upstream.response, new TransformStream(), controller, onAbortTerminal, stallMs, keepaliveMs);
  const reader = out.getReader();
  let text = "";
  let done = false;
  const pump = (async () => {
    while (true) {
      const r = await reader.read();
      if (r.done) { done = true; return; }
      text += dec.decode(r.value, { stream: true });
    }
  })().catch(() => { done = true; });
  return { reader, pump, get text() { return text; }, get done() { return done; } };
}

const count = (text) => text.split(SSE_KEEPALIVE).length - 1;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("stream keepalive", () => {
  it("writes an SSE comment after the configured silence, and repeats", async () => {
    const up = makeUpstream();
    const s = pipe(up, makeController());
    up.send("data: {\"a\":1}\n\n");
    await vi.advanceTimersByTimeAsync(KEEPALIVE - 1);
    expect(count(s.text)).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.text).toBe("data: {\"a\":1}\n\n" + SSE_KEEPALIVE);
    await vi.advanceTimersByTimeAsync(KEEPALIVE * 5);
    expect(count(s.text)).toBe(6);
    up.end();
    await s.pump;
  });

  it("starts before the first upstream byte", async () => {
    const up = makeUpstream();
    const s = pipe(up, makeController());
    await vi.advanceTimersByTimeAsync(KEEPALIVE);
    expect(s.text).toBe(SSE_KEEPALIVE);
    up.end();
    await s.pump;
  });

  it("stays quiet while chunks keep flowing", async () => {
    const up = makeUpstream();
    const s = pipe(up, makeController());
    for (let i = 0; i < 20; i++) {
      up.send(`data: {"i":${i}}\n\n`);
      await vi.advanceTimersByTimeAsync(KEEPALIVE - 1000);
    }
    expect(count(s.text)).toBe(0);
    up.end();
    await s.pump;
  });

  it("never splits an event that is still being written", async () => {
    const up = makeUpstream();
    const s = pipe(up, makeController());
    up.send("event: content_block_delta\n");
    await vi.advanceTimersByTimeAsync(KEEPALIVE * 3);
    expect(count(s.text)).toBe(0);
    up.send("data: {}\n");
    up.send("\n");
    await vi.advanceTimersByTimeAsync(KEEPALIVE);
    expect(s.text).toBe("event: content_block_delta\ndata: {}\n\n" + SSE_KEEPALIVE);
    up.end();
    await s.pump;
  });

  it("does nothing when disabled (0)", async () => {
    const up = makeUpstream();
    const s = pipe(up, makeController(), { keepaliveMs: 0 });
    up.send("data: {}\n\n");
    await vi.advanceTimersByTimeAsync(KEEPALIVE * 10);
    expect(count(s.text)).toBe(0);
    up.end();
    await s.pump;
  });

  it("stops when the stream completes", async () => {
    const up = makeUpstream();
    const ctl = makeController();
    const s = pipe(up, ctl);
    up.send("data: {}\n\n");
    up.end();
    await s.pump;
    expect(ctl.handleComplete).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    const before = s.text;
    await vi.advanceTimersByTimeAsync(KEEPALIVE * 4);
    expect(s.text).toBe(before);
  });

  it("stops when upstream errors", async () => {
    const up = makeUpstream();
    const ctl = makeController();
    const s = pipe(up, ctl);
    up.send("data: {}\n\n");
    await vi.advanceTimersByTimeAsync(0);
    up.fail(new Error("socket hang up"));
    await s.pump;
    expect(ctl.handleError).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops when the client disconnects", async () => {
    const up = makeUpstream();
    const ctl = makeController();
    const s = pipe(up, ctl);
    up.send("data: {}\n\n");
    await vi.advanceTimersByTimeAsync(KEEPALIVE);
    expect(count(s.text)).toBe(1);
    await s.reader.cancel("client_closed");
    expect(ctl.handleDisconnect).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops when the controller disconnects while the timer is pending", async () => {
    const up = makeUpstream();
    const ctl = makeController();
    const s = pipe(up, ctl);
    up.send("data: {}\n\n");
    await vi.advanceTimersByTimeAsync(KEEPALIVE);
    expect(count(s.text)).toBe(1);
    ctl.handleDisconnect("client_closed");
    await vi.advanceTimersByTimeAsync(KEEPALIVE * 4);
    expect(count(s.text)).toBe(1);
  });

  // Next drops a response whose client already left without reading or
  // cancelling its body; a short reply reaches upstream EOF anyway.
  it("stops once upstream has ended, even if nobody reads the body", async () => {
    const up = makeUpstream();
    pipeWithDisconnect(up.response, new TransformStream(), makeController(), null, STALL, KEEPALIVE);
    up.send("data: {}\n\n");
    up.end();
    await vi.advanceTimersByTimeAsync(KEEPALIVE * 10);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops after the stall timer fires, even if nobody reads the body", async () => {
    const up = makeUpstream();
    const stall = KEEPALIVE * 2 + 5000;
    pipeWithDisconnect(up.response, new TransformStream(), makeController(), null, stall, KEEPALIVE);
    up.send("data: {}\n\n");
    await vi.advanceTimersByTimeAsync(stall + KEEPALIVE * 2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not reset the upstream stall timer", async () => {
    const up = makeUpstream();
    const ctl = makeController();
    // The stall abort tears the upstream fetch down, which errors its body.
    ctl.abort.mockImplementation(() => up.fail(Object.assign(new Error("aborted"), { name: "AbortError" })));
    const terminal = vi.fn((msg) => enc.encode(`data: {"error":"${msg}"}\n\n`));
    const stall = KEEPALIVE * 4 + 5000;
    const s = pipe(up, ctl, { stallMs: stall, onAbortTerminal: terminal });
    up.send("data: {}\n\n");
    await vi.advanceTimersByTimeAsync(stall);
    await s.pump;
    expect(count(s.text)).toBe(4);
    expect(ctl.handleError).toHaveBeenCalledWith(expect.objectContaining({ message: "stream stall timeout" }));
    expect(terminal).toHaveBeenCalledWith("stream stall timeout");
    expect(s.text.endsWith(`data: {"error":"stream stall timeout"}\n\n`)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("STREAM_KEEPALIVE_MS", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it("defaults to 15s", async () => {
    vi.stubEnv("STREAM_KEEPALIVE_MS", "");
    vi.resetModules();
    const { STREAM_KEEPALIVE_MS } = await import("../../open-sse/config/runtimeConfig.js");
    expect(STREAM_KEEPALIVE_MS).toBe(15_000);
  });

  it("accepts 0 to disable", async () => {
    vi.stubEnv("STREAM_KEEPALIVE_MS", "0");
    vi.resetModules();
    const { STREAM_KEEPALIVE_MS, STREAM_STALL_TIMEOUT_MS } = await import("../../open-sse/config/runtimeConfig.js");
    expect(STREAM_KEEPALIVE_MS).toBe(0);
    expect(STREAM_STALL_TIMEOUT_MS).toBe(360_000);
  });

  it.each(["abc", "-1", String(2 ** 31)])("ignores %s", async (raw) => {
    vi.stubEnv("STREAM_KEEPALIVE_MS", raw);
    vi.resetModules();
    const { STREAM_KEEPALIVE_MS } = await import("../../open-sse/config/runtimeConfig.js");
    expect(STREAM_KEEPALIVE_MS).toBe(15_000);
  });
});

// Shared parser for every *_MS override in runtimeConfig.js.
describe("ms env overrides", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  async function stallFor(raw) {
    vi.stubEnv("STREAM_STALL_TIMEOUT_MS", raw);
    vi.resetModules();
    return (await import("../../open-sse/config/runtimeConfig.js")).STREAM_STALL_TIMEOUT_MS;
  }

  it("keeps 0 out of timers that must stay positive", async () => {
    expect(await stallFor("0")).toBe(360_000);
  });

  // Above 2^31-1, setTimeout fires at once and every stream would stall.
  it("ignores values setTimeout can't honour", async () => {
    expect(await stallFor(String(2 ** 31))).toBe(360_000);
    expect(await stallFor(String(2 ** 31 - 1))).toBe(2 ** 31 - 1);
  });

  it("still reads integer prefixes as before", async () => {
    expect(await stallFor("600000")).toBe(600_000);
    expect(await stallFor("600000ms")).toBe(600_000);
  });
});

// Only client formats whose SSE parsers skip comment lines get keepalives.
describe("keepalive by client format", () => {
  afterEach(() => { vi.doUnmock("../../open-sse/utils/streamHandler.js"); vi.doUnmock("@/lib/usageDb.js"); vi.unstubAllEnvs(); vi.resetModules(); });

  async function keepaliveFor(sourceFormat, env = "") {
    vi.stubEnv("STREAM_KEEPALIVE_MS", env);
    vi.resetModules();
    const pipeSpy = vi.fn(() => new ReadableStream());
    vi.doMock("../../open-sse/utils/streamHandler.js", () => ({ pipeWithDisconnect: pipeSpy }));
    vi.doMock("@/lib/usageDb.js", () => ({
      saveRequestDetail: vi.fn(() => Promise.resolve()),
      saveRequestUsage: vi.fn(() => Promise.resolve()),
      appendRequestLog: vi.fn(() => Promise.resolve()),
      trackPendingRequest: vi.fn(),
    }));
    const { handleStreamingResponse } = await import("../../open-sse/handlers/chatCore/streamingHandler.js");
    const { STREAM_KEEPALIVE_MS } = await import("../../open-sse/config/runtimeConfig.js");
    await handleStreamingResponse({
      providerResponse: new Response("", { headers: { "content-type": "text/event-stream" } }),
      provider: "openai", model: "m", sourceFormat, targetFormat: sourceFormat,
      body: {}, stream: true, requestStartTime: Date.now(), streamController: makeController(),
    });
    return { got: pipeSpy.mock.calls[0][5], want: STREAM_KEEPALIVE_MS };
  }

  it.each(["openai", "claude", "openai-responses"])("%s gets keepalives", async (fmt) => {
    const { got, want } = await keepaliveFor(fmt);
    expect(want).toBeGreaterThan(0);
    expect(got).toBe(want);
  });

  it.each(["gemini", "gemini-cli", "antigravity", "openai-response", "ollama"])("%s does not", async (fmt) => {
    const { got } = await keepaliveFor(fmt);
    expect(got).toBe(0);
  });

  it("is off for every format when STREAM_KEEPALIVE_MS=0", async () => {
    const { got } = await keepaliveFor("claude", "0");
    expect(got).toBe(0);
  });
});
