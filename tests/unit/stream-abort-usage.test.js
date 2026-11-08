// A stream that ends before its final event (hang-up, stall, upstream error)
// still records its usage, but not as a success.
import { describe, it, expect, vi, beforeEach } from "vitest";

const logs = vi.hoisted(() => ({ requestLog: vi.fn(async () => {}), detail: vi.fn(async () => {}), usage: vi.fn(async () => {}) }));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: logs.requestLog,
  saveRequestDetail: logs.detail,
  saveRequestUsage: logs.usage,
}));

const { createPassthroughStreamWithLogger, createSSETransformStreamWithLogger } = await import("open-sse/utils/stream.js");
const { buildOnStreamComplete } = await import("open-sse/handlers/chatCore/streamingHandler.js");
const { createStreamController, pipeWithDisconnect } = await import("open-sse/utils/streamHandler.js");
const { weighChars, estimateOutputTokens, estimateBillingInputTokens, estimateInputTokens } = await import("open-sse/utils/usageTracking.js");
const { FORMATS } = await import("open-sse/translator/formats.js");

const encoder = new TextEncoder();
const body = { model: "gpt-x", input: [{ role: "user", content: "please call the tool for me with the right path" }] };

/** Push SSE text through a passthrough stream, then end it the given way. */
async function run(parts, end, requestBody = body) {
  const completed = [];
  const ts = createPassthroughStreamWithLogger("codex", null, "gpt-x", "conn", requestBody, (...args) => completed.push(args), "sk-test");
  const writer = ts.writable.getWriter();
  const reader = ts.readable.getReader();
  const drain = (async () => { for (;;) { const { done } = await reader.read(); if (done) break; } })().catch(() => {});
  for (const part of parts) await writer.write(encoder.encode(part));
  if (end === "abort") {
    ts.finalizeOnAbort();
    await writer.abort(new Error("client went away")).catch(() => {});
  } else {
    await writer.close();
  }
  await drain;
  return completed;
}

const ev = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

beforeEach(() => {
  logs.requestLog.mockClear();
  logs.detail.mockClear();
  logs.usage.mockClear();
});

describe("a stream cut before its final event", () => {
  it("Responses function call (arguments as deltas): charges input and the arguments", async () => {
    const [[, usage, , meta]] = await run([
      ev("response.output_item.added", { type: "response.output_item.added", item: { type: "function_call", id: "fc_1", name: "read_file" } }),
      ev("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", delta: "{\"path\": \"/a/long/path/to/some/file.txt\"}" }),
    ], "abort");
    expect(usage.prompt_tokens).toBeGreaterThan(0);
    expect(usage.completion_tokens).toBeGreaterThan(5);
    expect(meta).toEqual({ aborted: true });
  });

  it("Responses function call (arguments only in output_item.done): charges input and the arguments", async () => {
    const [[, usage]] = await run([
      ev("response.output_item.done", { type: "response.output_item.done", item: { type: "function_call", call_id: "c1", name: "read_file", arguments: "{\"path\": \"/a/long/path/to/some/file.txt\"}" } }),
    ], "abort");
    expect(usage.prompt_tokens).toBeGreaterThan(0);
    expect(usage.completion_tokens).toBeGreaterThan(5);
  });

  it("Anthropic tool input (input_json_delta) counts toward the output", async () => {
    const [[, usage]] = await run([
      ev("message_start", { type: "message_start", message: { usage: { input_tokens: 500, output_tokens: 1 } } }),
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"path\": \"/a/long/path/to/some/file/being/written.txt\"" } }),
    ], "abort");
    expect(usage.input_tokens ?? usage.prompt_tokens).toBe(500);
    expect(usage.output_tokens ?? usage.completion_tokens).toBeGreaterThan(5);
  });

  it("with nothing streamed yet, still charges the input the upstream read", async () => {
    const [[, usage]] = await run([], "abort");
    expect(usage.prompt_tokens).toBeGreaterThan(0);
  });

  it("is not logged as a 200, and its request detail is not a success", async () => {
    // No body to estimate from and nothing streamed: no usage at all, and still no 200 line.
    const [[, usage]] = await run([], "abort", null);
    expect(usage).toBeFalsy();
    expect(logs.requestLog).not.toHaveBeenCalledWith(expect.objectContaining({ status: "200 OK" }));

    const { onStreamComplete } = buildOnStreamComplete({ provider: "codex", model: "gpt-x", connectionId: "conn", apiKey: "sk-test", requestStartTime: Date.now(), body, stream: true });
    onStreamComplete({ content: "" }, { prompt_tokens: 10, completion_tokens: 0 }, null, { aborted: true });
    expect(logs.detail).toHaveBeenLastCalledWith(expect.objectContaining({ status: "error" }));
    expect(logs.usage).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "sk-test" }));
  });
});

describe("a stream that ends normally", () => {
  it("is still a success, and a stream with no content is still logged as 200 with no usage", async () => {
    const completed = await run([], "close");
    expect(completed[0][3]).toEqual({ aborted: false });
    expect(completed[0][1]).toBeFalsy();
    expect(logs.requestLog).toHaveBeenCalledWith(expect.objectContaining({ status: "200 OK" }));

    const { onStreamComplete } = buildOnStreamComplete({ provider: "codex", model: "gpt-x", connectionId: "conn", apiKey: "sk-test", requestStartTime: Date.now(), body, stream: true });
    onStreamComplete({ content: "ok" }, { prompt_tokens: 10, completion_tokens: 2 }, null);
    expect(logs.detail).toHaveBeenLastCalledWith(expect.objectContaining({ status: "success" }));
  });
});

// ---- Round 3: drain for budgeted keys, terminal shapes, real usage over estimates ----

/** A fake upstream body the test feeds by hand; fetch-style, it errors when the controller aborts. */
function upstreamBody() {
  let ctrl;
  const state = { cancelled: false };
  const rs = new ReadableStream({ start(c) { ctrl = c; }, cancel() { state.cancelled = true; } });
  return {
    rs, state,
    push: (text) => ctrl.enqueue(encoder.encode(text)),
    close: () => { try { ctrl.close(); } catch { /* closed */ } },
    abortWith: (signal) => signal.addEventListener("abort", () => { try { ctrl.error(new DOMException("aborted", "AbortError")); } catch { /* closed */ } }),
  };
}

// Passthrough keeps the provider's field names or normalizes them; read either.
const outTok = (u) => u?.output_tokens ?? u?.completion_tokens;
const inTok = (u) => u?.input_tokens ?? u?.prompt_tokens;
const claudeEv = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** Pipe a fake upstream through the real stream + disconnect-aware wrapper. */
function pipe({ drain = false, drainMaxMs = 60_000, stallMs = 60_000, translate = null } = {}) {
  const completed = [];
  const onComplete = (...args) => completed.push(args);
  const ts = translate
    ? createSSETransformStreamWithLogger(translate.target, translate.source, "anthropic", null, null, "claude-x", "conn", body, onComplete, "sk-test")
    : createPassthroughStreamWithLogger("anthropic", null, "claude-x", "conn", body, onComplete, "sk-test");
  const controller = createStreamController({ provider: "anthropic", model: "claude-x", drainOnDisconnect: drain, drainMaxMs });
  const up = upstreamBody();
  up.abortWith(controller.signal);
  const out = pipeWithDisconnect(new Response(up.rs), ts, controller, null, stallMs, 0);
  return { up, out, completed, controller };
}

async function readUntil(reader, marker) {
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes(marker)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

const messageStart = claudeEv("message_start", { type: "message_start", message: { id: "m1", type: "message", role: "assistant", model: "claude-x", content: [], usage: { input_tokens: 3000, output_tokens: 1 } } });
// Omitted thinking: a block with only a signature, nothing to count.
const hiddenThinking = claudeEv("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } })
  + claudeEv("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "EqQBCgIYAhIM" } })
  + claudeEv("content_block_stop", { type: "content_block_stop", index: 0 });
const textBlock = (text) => claudeEv("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } })
  + claudeEv("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text } });
const messageDelta = (output) => claudeEv("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: output } });
const messageStop = claudeEv("message_stop", { type: "message_stop" });

describe("drain: a budgeted key's client hangs up mid-stream", () => {
  it("keeps reading the upstream and charges exactly the message_delta usage (omitted thinking)", async () => {
    const { up, out, completed } = pipe({ drain: true });
    const reader = out.getReader();
    up.push(messageStart + hiddenThinking + textBlock("short visible part"));
    await readUntil(reader, "short visible part");
    await reader.cancel();
    await tick();
    expect(up.state.cancelled).toBe(false);
    expect(completed).toHaveLength(0);

    // The hidden thinking was long; only the final usage says so.
    up.push(messageDelta(4321) + messageStop);
    await vi.waitFor(() => expect(completed).toHaveLength(1));
    const [, usage, , meta] = completed[0];
    expect(outTok(usage)).toBe(4321);
    expect(inTok(usage)).toBe(3000);
    expect(meta).toEqual({ aborted: false });
    await tick();
    expect(completed).toHaveLength(1);
  });

  it("charges exactly the response.completed usage of a Responses stream", async () => {
    const { up, out, completed } = pipe({ drain: true });
    const reader = out.getReader();
    up.push(ev("response.output_text.delta", { type: "response.output_text.delta", delta: "visible start" }));
    await readUntil(reader, "visible start");
    await reader.cancel();
    up.push(ev("response.completed", { type: "response.completed", response: { usage: { input_tokens: 900, output_tokens: 2500, output_tokens_details: { reasoning_tokens: 2400 } } } }));
    await vi.waitFor(() => expect(completed).toHaveLength(1));
    const [, usage] = completed[0];
    expect(usage.input_tokens ?? usage.prompt_tokens).toBe(900);
    expect(usage.output_tokens ?? usage.completion_tokens).toBe(2500);
  });

  it("an unbudgeted key's stream still drops the upstream at once", async () => {
    const { up, out, completed } = pipe({ drain: false });
    const reader = out.getReader();
    up.push(messageStart + textBlock("short visible part"));
    await readUntil(reader, "short visible part");
    await reader.cancel();
    await tick();
    expect(up.state.cancelled).toBe(true);
    expect(completed).toHaveLength(1);
    expect(completed[0][3]).toEqual({ aborted: true });
  });

  it("past the drain cap, aborts the upstream and falls back to the estimate", async () => {
    const { up, out, completed } = pipe({ drain: true, drainMaxMs: 60 });
    const reader = out.getReader();
    const text = "visible text before the hang-up";
    up.push(messageStart + textBlock(text));
    await readUntil(reader, "hang-up");
    await reader.cancel();
    await vi.waitFor(() => expect(completed).toHaveLength(1), { timeout: 2000 });
    const [, usage, , meta] = completed[0];
    expect(inTok(usage)).toBe(3000);
    expect(outTok(usage)).toBe(estimateOutputTokens(weighChars(text)));
    expect(meta).toEqual({ aborted: true });
  });
});

describe("terminal shapes", () => {
  it("a Claude passthrough read through message_stop and closed before upstream EOF is a success with exact usage", async () => {
    const { up, out, completed } = pipe({ drain: false });
    const reader = out.getReader();
    up.push(messageStart + textBlock("all of it") + messageDelta(57) + messageStop);
    await readUntil(reader, "message_stop");
    await reader.cancel();
    await vi.waitFor(() => expect(completed).toHaveLength(1));
    const [, usage, , meta] = completed[0];
    expect(outTok(usage)).toBe(57);
    expect(meta).toEqual({ aborted: false });
  });

  it("a Responses client on a Claude upstream, closed on response.completed, is a success", async () => {
    const { up, out, completed } = pipe({ translate: { target: FORMATS.CLAUDE, source: FORMATS.OPENAI_RESPONSES } });
    const reader = out.getReader();
    up.push(messageStart + textBlock("answer") + messageDelta(42) + messageStop);
    await readUntil(reader, "response.completed");
    await reader.cancel();
    await vi.waitFor(() => expect(completed).toHaveLength(1));
    const [, usage, , meta] = completed[0];
    expect(meta).toEqual({ aborted: false });
    expect(usage.output_tokens ?? usage.completion_tokens).toBe(42);
  });

  it("an upstream whose finish only its translator knows (commandcode) is a success when closed after it", async () => {
    const completed = [];
    const ts = createSSETransformStreamWithLogger(FORMATS.COMMANDCODE, FORMATS.OPENAI_RESPONSES, "commandcode", null, null, "cc-x", "conn", body, (...a) => completed.push(a), "sk-test");
    const writer = ts.writable.getWriter();
    const reader = ts.readable.getReader();
    const drain = (async () => { for (;;) { const { done } = await reader.read(); if (done) break; } })().catch(() => {});
    for (const event of [{ type: "start" }, { type: "text-start", id: "t1" }, { type: "text-delta", id: "t1", text: "done answer" }, { type: "text-end", id: "t1" },
      { type: "finish-step", finishReason: "stop", usage: { inputTokens: 40, outputTokens: 3 } }]) {
      await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    }
    ts.finalizeOnAbort();
    await writer.abort(new Error("client went away")).catch(() => {});
    await drain;
    expect(completed[0][3]).toEqual({ aborted: false });
  });

  it("a clean EOF without message_delta (an in-stream error after text) isn't charged output_tokens: 1", async () => {
    const { up, out, completed } = pipe({ drain: false });
    const reader = out.getReader();
    const text = "a partial answer before the upstream gave up with an error";
    up.push(messageStart + textBlock(text) + claudeEv("error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
    up.close();
    await readUntil(reader, "Overloaded");
    await vi.waitFor(() => expect(completed).toHaveLength(1));
    expect(outTok(completed[0][1])).toBe(estimateOutputTokens(weighChars(text)));
  });
});

describe("real usage replaces an estimate", () => {
  const openaiChunk = (extra) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: "gpt-x", ...extra })}\n\n`;
  const finishWithoutUsage = openaiChunk({ choices: [{ index: 0, delta: { content: "hi there" }, finish_reason: "stop" }] });
  const usageChunk = openaiChunk({ choices: [], usage: { prompt_tokens: 150, completion_tokens: 20, total_tokens: 170 } });

  // A long prompt, so the estimate (about 1,000 tokens) is above the real 150:
  // a max-merge would keep the estimate.
  const longBody = { model: "gpt-x", messages: [{ role: "user", content: "word ".repeat(800) }] };

  it("in passthrough", async () => {
    const [[, usage]] = await run([finishWithoutUsage, usageChunk, "data: [DONE]\n\n"], "close", longBody);
    expect(usage.prompt_tokens).toBe(150);
    expect(usage.completion_tokens).toBe(20);
  });

  it("in translate mode", async () => {
    const completed = [];
    const ts = createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.CLAUDE, "openai", null, null, "gpt-x", "conn", longBody, (...a) => completed.push(a), "sk-test");
    const writer = ts.writable.getWriter();
    const reader = ts.readable.getReader();
    const drain = (async () => { for (;;) { const { done } = await reader.read(); if (done) break; } })().catch(() => {});
    for (const part of [finishWithoutUsage, usageChunk, "data: [DONE]\n\n"]) await writer.write(encoder.encode(part));
    await writer.close().catch(() => {});
    await drain;
    const [, usage] = completed[0];
    expect(usage.prompt_tokens ?? usage.input_tokens).toBe(150);
    expect(usage.completion_tokens ?? usage.output_tokens).toBe(20);
  });
});

describe("billing estimates", () => {
  it("count non-ASCII text at about a token per character", () => {
    expect(weighChars("hello world!")).toBe(12);
    expect(estimateOutputTokens(weighChars("你好世界你好世界"))).toBe(8);
  });

  it("count custom tool input, choice reasoning and Ollama content toward the output", async () => {
    const [[, custom]] = await run([ev("response.custom_tool_call_input.delta", { type: "response.custom_tool_call_input.delta", delta: "x".repeat(400) })], "abort");
    expect(custom.completion_tokens).toBe(100);
    const [[, reasoning]] = await run([`data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning: "y".repeat(400) } }] })}\n\n`], "abort");
    expect(reasoning.completion_tokens).toBe(100);
    const [[, ollama]] = await run([`data: ${JSON.stringify({ message: { role: "assistant", content: "z".repeat(400) }, done: false })}\n\n`], "abort");
    expect(ollama.completion_tokens).toBe(100);
  });

  it("bill input without the context-meter buffer, and an image at a flat rate rather than as base64 text", () => {
    const text = { messages: [{ role: "user", content: "a".repeat(4000) }] };
    expect(estimateBillingInputTokens(text)).toBeLessThan(estimateInputTokens(text) + 50);
    expect(estimateBillingInputTokens(text)).toBeGreaterThan(1000);
    const withImage = { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(400_000)}` } }] }] };
    expect(estimateBillingInputTokens(withImage)).toBeLessThan(2000);
    expect(estimateInputTokens(withImage)).toBeGreaterThan(100_000);
    const anthropicImage = { messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "B".repeat(400_000) } }] }] };
    expect(estimateBillingInputTokens(anthropicImage)).toBeLessThan(2000);
  });
});

describe("the done line", () => {
  it("is written for a finished stream and not for one cut short", async () => {
    const line = vi.fn();
    const { onStreamComplete } = buildOnStreamComplete({ provider: "anthropic", model: "claude-x", connectionId: "conn", apiKey: "sk-test", requestStartTime: Date.now(), body, stream: true, log: { line } });
    const ts = createPassthroughStreamWithLogger("anthropic", null, "claude-x", "conn", body, onStreamComplete, "sk-test");
    const controller = createStreamController({ provider: "anthropic", model: "claude-x" });
    const up = upstreamBody();
    const reader = pipeWithDisconnect(new Response(up.rs), ts, controller, null, 60_000, 0).getReader();
    up.push(messageStart + textBlock("cut"));
    await readUntil(reader, "cut");
    await reader.cancel();
    await tick();
    expect(line.mock.calls.filter(([, symbol]) => symbol === "📊")).toHaveLength(0);

    const finished = buildOnStreamComplete({ provider: "anthropic", model: "claude-x", connectionId: "conn", apiKey: "sk-test", requestStartTime: Date.now(), body, stream: true, log: { line } });
    const ts2 = createPassthroughStreamWithLogger("anthropic", null, "claude-x", "conn", body, finished.onStreamComplete, "sk-test");
    const up2 = upstreamBody();
    const reader2 = pipeWithDisconnect(new Response(up2.rs), ts2, createStreamController({ provider: "anthropic", model: "claude-x" }), null, 60_000, 0).getReader();
    up2.push(messageStart + textBlock("all") + messageDelta(5) + messageStop);
    up2.close();
    await readUntil(reader2, "message_stop");
    await vi.waitFor(() => expect(line.mock.calls.filter(([, symbol]) => symbol === "📊")).toHaveLength(1));
  });
});
