import { describe, expect, it } from "vitest";

import { createDisconnectAwareStream, pipeWithDisconnect, createStreamController } from "../../open-sse/utils/streamHandler.js";
import { buildAbortedResponsesTerminalBytes } from "../../open-sse/utils/responsesStreamHelpers.js";
import { buildStreamErrorBytes } from "../../open-sse/utils/streamHelpers.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSEStream } from "../../open-sse/utils/stream.js";

// Minimal stream controller stub
function makeController() {
  let connected = true;
  return {
    signal: new AbortController().signal,
    startTime: Date.now(),
    isConnected: () => connected,
    handleComplete: () => { connected = false; },
    handleError: () => { connected = false; },
    handleDisconnect: () => { connected = false; },
    abort: () => { connected = false; },
  };
}

async function readAll(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

describe("Responses abort terminal synthesis", () => {
  it("emits response.failed + [DONE] when upstream errors (abort/stall)", async () => {
    // Upstream readable that errors mid-stream (simulates fetch abort on stall)
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: response.created\ndata: {}\n\n"));
        controller.error(new Error("stream stall timeout"));
      },
    });

    const out = createDisconnectAwareStream(
      { readable: upstream, writable: { getWriter: () => ({ abort: () => Promise.resolve() }) } },
      makeController(),
      buildAbortedResponsesTerminalBytes
    );

    const text = await readAll(out);
    expect(text).toContain("event: response.failed");
    expect(text).toContain("data: [DONE]");
  });

  it("does not synthesize terminal for non-Responses streams (callback null)", async () => {
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: hi\n\n"));
        controller.error(new Error("socket hang up"));
      },
    });

    const out = createDisconnectAwareStream(
      { readable: upstream, writable: { getWriter: () => ({ abort: () => Promise.resolve() }) } },
      makeController(),
      null
    );

    const text = await readAll(out);
    expect(text).not.toContain("response.failed");
    expect(text).not.toContain("[DONE]");
  });
});

// A stream that aborts after HTTP 200 cannot change status, so the failure must
// travel in-band: structured error frame first, then [DONE]. openai-python raises
// APIError on any `data:` payload carrying an `error` key (checked before [DONE]);
// Anthropic clients need `event: error`. Never a fabricated finish_reason.
describe("buildStreamErrorBytes", () => {
  const jsonOf = (sse) => JSON.parse(sse.match(/\{.*\}/s)[0]);
  const textOf = (bytes) => new TextDecoder().decode(bytes);

  // onAbortTerminal callbacks are enqueued verbatim, so a string here is a
  // silent no-op at runtime (createDisconnectAwareStream swallows the throw).
  it("returns bytes, not a string", () => {
    expect(buildStreamErrorBytes(504, "x", FORMATS.OPENAI)).toBeInstanceOf(Uint8Array);
  });

  it("emits error frame then [DONE] for OpenAI clients", () => {
    const out = textOf(buildStreamErrorBytes(504, "stream stall timeout", FORMATS.OPENAI));

    expect(out).toContain('data: {"error"');
    expect(out.indexOf("data: [DONE]")).toBeGreaterThan(out.indexOf('data: {"error"'));

    expect(jsonOf(out).error).toEqual({
      message: "stream stall timeout",
      type: "server_error",
      code: "gateway_timeout",
    });
  });

  it("emits event: error (no [DONE]) for Claude clients", () => {
    const out = textOf(buildStreamErrorBytes(504, "stream stall timeout", FORMATS.CLAUDE));

    expect(out).toContain("event: error\n");
    expect(out).not.toContain("[DONE]");
    expect(jsonOf(out)).toMatchObject({ type: "error", error: { message: "stream stall timeout" } });
  });
});

// The wiring, not just the frame builder: the watchdog must hand its reason to
// onAbortTerminal and the bytes must reach a real consumer.
describe("stall abort through pipeWithDisconnect", () => {
  it("delivers the error frame and closes the stream", async () => {
    // Real controller: the stub above never fires its signal, and the abort
    // must reach the upstream body for the pipe to end.
    const ctrl = createStreamController({ provider: "ollama", model: "test" });

    // Emits one chunk then goes silent; errors on abort like a real fetch body.
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: hi\n\n"));
        ctrl.signal.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
      },
    });

    let seen = null;
    const out = pipeWithDisconnect(
      { body: upstream },
      new TransformStream(),
      ctrl,
      (message) => { seen = message; return buildStreamErrorBytes(504, message, FORMATS.OPENAI); },
      50
    );

    const text = await readAll(out);
    expect(seen).toBe("stream stall timeout");
    expect(text).toContain('"stream stall timeout"');
    expect(text).toContain("data: [DONE]");
  });

  // Kiro, grok-web and perplexity-web catch the aborted read and end their body
  // cleanly, so the translate stream's flush() writes its own terminal first.
  it("sends one [DONE] when the upstream closes cleanly on the abort", async () => {
    const ctrl = createStreamController({ provider: "kiro", model: "test" });
    const claude = (data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          claude({ type: "message_start", message: { id: "msg_abcdefgh", model: "claude-x", usage: { input_tokens: 5, output_tokens: 1 } } })
          + claude({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
          + claude({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } }),
        ));
        ctrl.signal.addEventListener("abort", () => controller.close(), { once: true });
      },
    });

    const out = pipeWithDisconnect(
      { body: upstream },
      createSSEStream({ mode: "translate", targetFormat: FORMATS.CLAUDE, sourceFormat: FORMATS.OPENAI, provider: "kiro", model: "test" }),
      ctrl,
      (message) => buildStreamErrorBytes(504, message, FORMATS.OPENAI),
      50
    );

    const text = await readAll(out);
    expect(text).toContain('"content":"hello"');
    expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(text.match(/data: \{"error"/g)).toHaveLength(1);
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  it("sends the error frame and [DONE] when a real translate stream stalls before its terminal", async () => {
    const ctrl = createStreamController({ provider: "claude", model: "test" });
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_abcdefgh", model: "claude-x", usage: { input_tokens: 5, output_tokens: 1 } } })}\n\n`,
        ));
        ctrl.signal.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
      },
    });

    const out = pipeWithDisconnect(
      { body: upstream },
      createSSEStream({ mode: "translate", targetFormat: FORMATS.CLAUDE, sourceFormat: FORMATS.OPENAI, provider: "claude", model: "test" }),
      ctrl,
      (message) => buildStreamErrorBytes(504, message, FORMATS.OPENAI),
      50
    );

    const text = await readAll(out);
    expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(text.match(/data: \{"error"/g)).toHaveLength(1);
    expect(text).toContain('"stream stall timeout"');
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
  });
});

// The transform's [DONE] counts only once it reaches the client: an upstream
// error after it was queued discards the queue, and the fallback must still go out.
describe("a terminal queued but never read", () => {
  it("still gets the error frame and [DONE] when the upstream resets before the client reads it", async () => {
    const ts = createSSEStream({ mode: "passthrough", provider: "openai-compatible-x", model: "test" });
    const writer = ts.writable.getWriter();
    const out = createDisconnectAwareStream(
      {
        readable: ts.readable,
        writable: { getWriter: () => ({ abort: () => Promise.resolve() }) },
        finalizeOnAbort: ts.finalizeOnAbort,
        terminalSent: ts.terminalSent,
        terminalChunk: ts.terminalChunk,
      },
      makeController(),
      (message = "upstream connection lost") => buildStreamErrorBytes(502, message, FORMATS.OPENAI),
    );
    const reader = out.getReader();
    const decoder = new TextDecoder();

    // The usage chunk and [DONE] arrive in one network chunk.
    const usage = { id: "chatcmpl-abc12345", object: "chat.completion.chunk", created: 1, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } };
    await writer.write(new TextEncoder().encode(`data: ${JSON.stringify(usage)}\n\ndata: [DONE]\n\n`));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ts.terminalSent()).toBe(true);
    // The connection resets before the client has read the queued [DONE].
    await writer.abort(new Error("ECONNRESET")).catch(() => {});

    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    expect(text).toContain('"finish_reason":"stop"');
    expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(text.match(/data: \{"error"/g)).toHaveLength(1);
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
  });
});
