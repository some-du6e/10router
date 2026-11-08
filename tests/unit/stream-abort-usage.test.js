// A stream that ends before its final event (hang-up, stall, upstream error)
// still records its usage, but not as a success.
import { describe, it, expect, vi, beforeEach, onTestFinished } from "vitest";

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
async function run(parts, end, requestBody = body, { provider = "codex", output = null, onWrite = null } = {}) {
  const completed = [];
  const ts = createPassthroughStreamWithLogger(provider, null, "gpt-x", "conn", requestBody, (...args) => completed.push(args), "sk-test");
  const writer = ts.writable.getWriter();
  const reader = ts.readable.getReader();
  const decoder = new TextDecoder();
  const drain = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) break; if (output) output.push(decoder.decode(value)); } })().catch(() => {});
  for (const part of parts) { await writer.write(encoder.encode(part)); onWrite?.(); }
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
function pipe({ drain = false, drainMaxMs = 60_000, stallMs = 60_000, translate = null, requestBody = body, sentBody = undefined, upstreamStartedAt = undefined } = {}) {
  const completed = [];
  const onComplete = (...args) => completed.push(args);
  const ts = translate
    ? createSSETransformStreamWithLogger(translate.target, translate.source, "anthropic", null, null, "claude-x", "conn", requestBody, onComplete, "sk-test")
    : createPassthroughStreamWithLogger("anthropic", null, "claude-x", "conn", requestBody, onComplete, "sk-test");
  if (sentBody !== undefined) ts.upstreamBody = sentBody;
  if (upstreamStartedAt !== undefined) ts.upstreamStartedAt = upstreamStartedAt;
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

  it("past the drain cap, aborts the upstream and charges the time floor", async () => {
    const clock = fakeClock();
    const { up, out, completed } = pipe({ drain: true, drainMaxMs: 60 });
    const reader = out.getReader();
    up.push(messageStart + textBlock("visible text before the hang-up"));
    await readUntil(reader, "hang-up");
    clock.advance(4000);
    await reader.cancel();
    await vi.waitFor(() => expect(completed).toHaveLength(1), { timeout: 2000 });
    const [, usage, , meta] = completed[0];
    expect(inTok(usage)).toBe(3000);
    expect(outTok(usage)).toBe(4 * 150);
    expect(meta).toEqual({ aborted: true });
  });

  it("a drain that reaches the upstream's end without final usage is an error, not a success", async () => {
    const { up, out, completed } = pipe({ drain: true });
    const reader = out.getReader();
    up.push(messageStart + textBlock("no final usage will come"));
    await readUntil(reader, "will come");
    await reader.cancel();
    up.close();
    await vi.waitFor(() => expect(completed).toHaveLength(1));
    expect(completed[0][3]).toEqual({ aborted: true });
  });

  it("keeps the stall watchdog armed while draining", async () => {
    const { out, completed, up } = pipe({ drain: true, drainMaxMs: 60_000, stallMs: 80 });
    const reader = out.getReader();
    up.push(messageStart + textBlock("then the upstream went quiet"));
    await readUntil(reader, "went quiet");
    await reader.cancel();
    // Only the stall (80 ms) can end this drain; the cap is a minute away.
    await vi.waitFor(() => expect(completed).toHaveLength(1), { timeout: 2000 });
    expect(completed[0][3]).toEqual({ aborted: true });
  });

  it("starts from a hang-up seen on the client signal, not just a cancelled body", async () => {
    const { up, out, completed, controller } = pipe({ drain: true });
    const reader = out.getReader();
    up.push(messageStart + textBlock("signal hang-up"));
    await readUntil(reader, "signal hang-up");
    // What chatCore's clientSignal listener does on a hang-up mid-stream.
    controller.handleDisconnect("client_closed");
    await tick();
    expect(up.state.cancelled).toBe(false);
    up.push(messageDelta(321) + messageStop);
    await vi.waitFor(() => expect(completed).toHaveLength(1));
    expect(outTok(completed[0][1])).toBe(321);
    expect(completed[0][3]).toEqual({ aborted: false });
  });
});

/** Control Date.now (the floor's clock) from the test. */
function fakeClock() {
  let now = Date.now();
  const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
  onTestFinished(() => spy.mockRestore());
  return { advance: (ms) => { now += ms; } };
}

describe("cut-short floor", () => {
  it("charges a Claude stream with omitted thinking, cut at 20 s, at least 20 x 150 output tokens", async () => {
    const clock = fakeClock();
    const { up, out, completed } = pipe({ drain: false });
    const reader = out.getReader();
    up.push(messageStart + hiddenThinking + textBlock("tiny"));
    await readUntil(reader, "tiny");
    clock.advance(20_000);
    await reader.cancel();
    await vi.waitFor(() => expect(completed).toHaveLength(1));
    expect(outTok(completed[0][1])).toBe(20 * 150);
    expect(inTok(completed[0][1])).toBe(3000);
  });

  it("never charges more than the request's max_tokens", async () => {
    const clock = fakeClock();
    const { up, out, completed } = pipe({ drain: false, requestBody: { ...body, max_tokens: 1000 } });
    const reader = out.getReader();
    up.push(messageStart + hiddenThinking + textBlock("tiny"));
    await readUntil(reader, "tiny");
    clock.advance(20_000);
    await reader.cancel();
    await vi.waitFor(() => expect(completed).toHaveLength(1));
    expect(outTok(completed[0][1])).toBe(1000);
  });

  it("raises both output field names when the usage carries both", async () => {
    const clock = fakeClock();
    const { up, out, completed } = pipe({ drain: false, translate: { target: FORMATS.CLAUDE, source: FORMATS.OPENAI } });
    const reader = out.getReader();
    up.push(messageStart + textBlock("both names"));
    await readUntil(reader, "both names");
    clock.advance(2000);
    await reader.cancel();
    await vi.waitFor(() => expect(completed).toHaveLength(1));
    const [, usage] = completed[0];
    expect(usage.completion_tokens).toBe(300);
    expect(usage.output_tokens).toBe(300);
  });

  it("leaves a completed stream's usage exact, however long it ran", async () => {
    const clock = fakeClock();
    const { up, out, completed } = pipe({ drain: false });
    const reader = out.getReader();
    up.push(messageStart + textBlock("all of it"));
    clock.advance(60_000);
    up.push(messageDelta(57) + messageStop);
    up.close();
    await readUntil(reader, "message_stop");
    await vi.waitFor(() => expect(completed).toHaveLength(1));
    expect(outTok(completed[0][1])).toBe(57);
  });
});

describe("terminal shapes", () => {
  it("Gemini finishReason with usageMetadata ends the answer (passthrough, no translator)", async () => {
    const completed = [];
    const ts = createPassthroughStreamWithLogger("gemini", null, "g", "conn", body, (...a) => completed.push(a), "sk-test");
    const writer = ts.writable.getWriter();
    const reader = ts.readable.getReader();
    const drain = (async () => { for (;;) { const { done } = await reader.read(); if (done) break; } })().catch(() => {});
    await writer.write(encoder.encode(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 } })}\n\n`));
    ts.finalizeOnAbort();
    await writer.abort(new Error("client went away")).catch(() => {});
    await drain;
    expect(completed[0][3]).toEqual({ aborted: false });
  });

  it("Ollama's done ends the answer", async () => {
    const completed = [];
    const ts = createSSETransformStreamWithLogger(FORMATS.OLLAMA, FORMATS.OPENAI, "ollama", null, null, "o", "conn", body, (...a) => completed.push(a), "sk-test");
    const writer = ts.writable.getWriter();
    const reader = ts.readable.getReader();
    const drain = (async () => { for (;;) { const { done } = await reader.read(); if (done) break; } })().catch(() => {});
    await writer.write(encoder.encode(`${JSON.stringify({ model: "o", message: { role: "assistant", content: "hi" }, done: false })}\n`));
    await writer.write(encoder.encode(`${JSON.stringify({ model: "o", message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 7, eval_count: 3 })}\n`));
    ts.finalizeOnAbort();
    await writer.abort(new Error("client went away")).catch(() => {});
    await drain;
    expect(completed[0][3]).toEqual({ aborted: false });
  });

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
    // On master the estimate (input_tokens ~2,000) sat next to the real
    // prompt_tokens; every input and output field must hold the real value.
    expect(Math.max(usage.prompt_tokens ?? 0, usage.input_tokens ?? 0)).toBe(150);
    expect(Math.max(usage.completion_tokens ?? 0, usage.output_tokens ?? 0)).toBe(20);
  });
});

describe("a completed stream with no usage at all", () => {
  it("records the estimate with no context-meter buffer, and no time floor", async () => {
    const clock = fakeClock();
    const content = "a complete answer of moderate length";
    const [[, usage, , meta]] = await run([
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: "stop" }] })}\n\n`, "data: [DONE]\n\n",
    ], "close", body, { onWrite: () => clock.advance(30_000) });
    expect(meta).toEqual({ aborted: false });
    expect(usage.prompt_tokens).toBe(estimateBillingInputTokens(body));
    expect(usage.prompt_tokens).toBeLessThan(100);
    expect(usage.completion_tokens).toBe(estimateOutputTokens(weighChars(content)));
  });
});

describe("the usage chunk 10router asked for", () => {
  const usageOnly = `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 } })}\n\n`;
  const finish = `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "hey" }, finish_reason: "stop" }] })}\n\n`;

  it("isn't forwarded when the client didn't ask, but its usage is kept", async () => {
    const output = [];
    const [[, usage]] = await run([finish, usageOnly, "data: [DONE]\n\n"], "close", body, { provider: "openai", output });
    expect(output.join("")).not.toContain('"choices":[]');
    expect(usage.prompt_tokens).toBe(11);
  });

  it("is forwarded when the client asked for it", async () => {
    const output = [];
    const asked = { ...body, stream_options: { include_usage: true } };
    const [[, usage]] = await run([finish, usageOnly, "data: [DONE]\n\n"], "close", asked, { provider: "openai", output });
    expect(output.join("")).toContain('"choices":[]');
    expect(usage.prompt_tokens).toBe(11);
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
    const [[, customItem]] = await run([ev("response.output_item.done", { type: "response.output_item.done", item: { type: "custom_tool_call", call_id: "c1", name: "apply_patch", input: "p".repeat(400) } })], "abort");
    expect(customItem.completion_tokens).toBe(100);
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

  it("bill other inline files by decoded size: PDF data URLs, Claude documents, Gemini inlineData, input_audio", () => {
    const b64 = "C".repeat(160_000); // 120 KB decoded = 30,000 tokens
    const bySize = 30_000;
    const near = (v) => expect(Math.abs(v - bySize)).toBeLessThan(200);
    near(estimateBillingInputTokens({ messages: [{ role: "user", content: [{ type: "file", file: { file_data: `data:application/pdf;base64,${b64}` } }] }] }));
    near(estimateBillingInputTokens({ messages: [{ role: "user", content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }] }] }));
    near(estimateBillingInputTokens({ contents: [{ role: "user", parts: [{ inlineData: { mimeType: "audio/wav", data: b64 } }] }] }));
    near(estimateBillingInputTokens({ contents: [{ role: "user", parts: [{ inline_data: { mime_type: "application/pdf", data: b64 } }] }] }));
    near(estimateBillingInputTokens({ messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: b64, format: "wav" } }] }] }));
    // A Gemini inline image is flat, like the others.
    expect(estimateBillingInputTokens({ contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/jpeg", data: b64 } }] }] })).toBeLessThan(2000);
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

describe("non-streaming request over a forced Responses stream with no usage", () => {
  it("records, logs and details the same estimate", async () => {
    const { handleForcedSSEToJson } = await import("open-sse/handlers/chatCore/sseToJsonHandler.js");
    const text = "an answer that came with no usage at all";
    const sse = ev("response.created", { type: "response.created", response: { id: "r1", status: "in_progress", output: [] } })
      + ev("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { id: "m1", type: "message", role: "assistant", content: [] } })
      + ev("response.output_text.delta", { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text })
      + ev("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { id: "m1", type: "message", role: "assistant", content: [{ type: "output_text", text }] } })
      + ev("response.completed", { type: "response.completed", response: { id: "r1", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }] } });
    const appendLog = vi.fn();
    const result = await handleForcedSSEToJson({
      providerResponse: new Response(sse, { headers: { "content-type": "text/event-stream" } }),
      sourceFormat: FORMATS.OPENAI_RESPONSES, targetFormat: FORMATS.OPENAI_RESPONSES, provider: "codex", model: "gpt-x",
      body, stream: false, requestStartTime: Date.now(), connectionId: "conn", apiKey: "sk-test",
      clientRawRequest: { endpoint: "/v1/responses" }, trackDone: vi.fn(), appendLog,
    });
    expect(result.success).toBe(true);
    const saved = logs.usage.mock.calls.at(-1)[0];
    expect(saved.apiKey).toBe("sk-test");
    expect(saved.tokens.prompt_tokens).toBe(estimateBillingInputTokens(body));
    expect(saved.tokens.completion_tokens).toBe(estimateOutputTokens(weighChars(text)));
    expect(appendLog).toHaveBeenCalledWith(expect.objectContaining({ tokens: expect.objectContaining({ output_tokens: estimateOutputTokens(weighChars(text)) }) }));
    const detail = logs.detail.mock.calls.at(-1)[0];
    expect(detail.tokens.completion_tokens).toBe(estimateOutputTokens(weighChars(text)));
  });
});

describe("non-streaming request over a forced chat stream with no usage", () => {
  it("details and logs the same estimate it records", async () => {
    const { handleForcedSSEToJson } = await import("open-sse/handlers/chatCore/sseToJsonHandler.js");
    const text = "a chat answer with no usage";
    const sse = `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text } }] })}\n\n`
      + `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
    const line = vi.fn();
    const result = await handleForcedSSEToJson({
      providerResponse: new Response(sse, { headers: { "content-type": "text/event-stream" } }),
      sourceFormat: FORMATS.OPENAI, targetFormat: FORMATS.OPENAI, provider: "openai-compatible-chat-x", model: "gpt-x",
      body, stream: false, requestStartTime: Date.now(), connectionId: "conn", apiKey: "sk-test",
      clientRawRequest: { endpoint: "/v1/chat/completions" }, trackDone: vi.fn(), appendLog: vi.fn(), log: { line }, reqTag: "t",
    });
    expect(result.success).toBe(true);
    const expected = estimateOutputTokens(weighChars(text));
    expect(logs.usage.mock.calls.at(-1)[0].tokens.completion_tokens).toBe(expected);
    expect(logs.detail.mock.calls.at(-1)[0].tokens.completion_tokens).toBe(expected);
    expect(line.mock.calls.at(-1)[2]).toContain(`OUT ${expected}`);
  });
});

// ---- Round 5 ----

/** Cut a Claude stream with only a little visible text at `seconds`, return the billed usage. */
async function cutAt(seconds, opts = {}, text = "tiny") {
  const clock = fakeClock();
  const { up, out, completed } = pipe({ drain: false, ...opts });
  const reader = out.getReader();
  up.push(messageStart + hiddenThinking + textBlock(text));
  await readUntil(reader, text);
  clock.advance(seconds * 1000);
  await reader.cancel();
  await vi.waitFor(() => expect(completed).toHaveLength(1));
  return completed[0][1];
}

describe("the floor's cap", () => {
  it("comes from the body sent upstream, not the client's (max_completion_tokens: 1 to Claude)", async () => {
    const usage = await cutAt(10, { requestBody: { ...body, max_completion_tokens: 1 }, sentBody: { max_tokens: 64000 } });
    expect(outTok(usage)).toBe(1500);
  });

  it("never shrinks below what visibly streamed", async () => {
    const text = "x".repeat(400);
    const usage = await cutAt(10, { requestBody: { ...body, max_tokens: 1 } }, text);
    expect(outTok(usage)).toBe(estimateOutputTokens(weighChars(text)));
  });

  it.each([
    ["max_output_tokens", { max_output_tokens: 700 }, 700],
    ["Gemini generationConfig.maxOutputTokens", { generationConfig: { maxOutputTokens: 800 } }, 800],
    ["antigravity request.generationConfig.maxOutputTokens", { request: { generationConfig: { maxOutputTokens: 900 } } }, 900],
  ])("reads %s", async (_name, sentBody, cap) => {
    expect(outTok(await cutAt(20, { sentBody }))).toBe(cap);
  });

  it("reads Kiro's inferenceConfig.maxTokens, not the client's max_tokens: 1", async () => {
    expect(outTok(await cutAt(10, { requestBody: { ...body, max_tokens: 1 }, sentBody: { inferenceConfig: { maxTokens: 32000 } } }))).toBe(1500);
    // and the upstream cap still bounds the floor: 300 s x 150 = 45000 > 32000
    expect(outTok(await cutAt(300, { requestBody: { ...body, max_tokens: 1 }, sentBody: { inferenceConfig: { maxTokens: 32000 } } }))).toBe(32000);
  });

  it("is uncapped when the upstream body has no cap (Codex strips it), whatever the client sent", async () => {
    const usage = await cutAt(10, { requestBody: { ...body, max_output_tokens: 1 }, sentBody: { model: "gpt-x", input: [] } });
    expect(outTok(usage)).toBe(1500);
  });

  it("reads a serialized upstream body", async () => {
    const usage = await cutAt(20, { requestBody: { ...body, max_tokens: 1 }, sentBody: JSON.stringify({ max_tokens: 700 }) });
    expect(outTok(usage)).toBe(700);
  });

  it("falls back to the client's cap only when nothing was sent upstream", async () => {
    expect(outTok(await cutAt(20, { requestBody: { ...body, max_tokens: 600 }, sentBody: null }))).toBe(600);
  });
});

describe("the floor's clock", () => {
  it("stops at the last upstream byte when the stall watchdog ended the stream", async () => {
    const clock = fakeClock();
    const text = "then nothing for a long time";
    const { up, out, completed } = pipe({ drain: false, stallMs: 80 });
    const reader = out.getReader();
    up.push(messageStart + textBlock(text));
    await readUntil(reader, "long time");
    clock.advance(300_000); // the silent window, which isn't generation
    await vi.waitFor(() => expect(completed).toHaveLength(1), { timeout: 2000 });
    expect(outTok(completed[0][1])).toBe(estimateOutputTokens(weighChars(text)));
  });

  it("starts at the first upstream byte, so prefill isn't billed", async () => {
    const clock = fakeClock();
    const { up, out, completed } = pipe({ drain: false });
    const reader = out.getReader();
    clock.advance(30_000); // headers came, then 30 s of prefill before any byte
    up.push(messageStart + textBlock("tiny"));
    await readUntil(reader, "tiny");
    clock.advance(2000);
    await reader.cancel();
    await vi.waitFor(() => expect(completed).toHaveLength(1));
    expect(outTok(completed[0][1])).toBe(2 * 150);
  });

  it("starts when the response arrived for an executor that read ahead (codex's peek)", async () => {
    const clock = fakeClock();
    const arrived = Date.now();
    const { up, out, completed } = pipe({ drain: false, upstreamStartedAt: arrived });
    const reader = out.getReader();
    clock.advance(8000); // the peek read reasoning events up to the first output delta
    up.push(messageStart + textBlock("tiny"));
    await readUntil(reader, "tiny");
    clock.advance(2000);
    await reader.cancel();
    await vi.waitFor(() => expect(completed).toHaveLength(1));
    expect(outTok(completed[0][1])).toBe(10 * 150);
  });

  it("codex stamps when its fetch returned, before the peek", async () => {
    const { BaseExecutor } = await import("open-sse/executors/base.js");
    const { CodexExecutor } = await import("open-sse/executors/codex.js");
    const sse = ev("response.output_text.delta", { type: "response.output_text.delta", delta: "hello" });
    const spy = vi.spyOn(BaseExecutor.prototype, "execute").mockResolvedValue({ response: new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }) });
    try {
      const before = Date.now();
      const result = await new CodexExecutor("codex").execute({ body: { input: [] }, model: "gpt-x", stream: true, credentials: {} });
      expect(result.response.upstreamStartedAt).toBeGreaterThanOrEqual(before);
      expect(result.response.upstreamStartedAt).toBeLessThanOrEqual(Date.now());
    } finally {
      spy.mockRestore();
    }
  });

  it("isn't applied after the finish chunk when the client hangs up before the usage trailer", async () => {
    const clock = fakeClock();
    const content = "the whole answer";
    const completed = [];
    const ts = createPassthroughStreamWithLogger("openai", null, "gpt-x", "conn", body, (...a) => completed.push(a), "sk-test");
    const writer = ts.writable.getWriter();
    const reader = ts.readable.getReader();
    const drain = (async () => { for (;;) { const { done } = await reader.read(); if (done) break; } })().catch(() => {});
    await writer.write(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: "stop" }] })}\n\n`));
    clock.advance(20_000);
    ts.finalizeOnAbort();
    await writer.abort(new Error("client went away")).catch(() => {});
    await drain;
    expect(completed[0][1].completion_tokens).toBe(estimateOutputTokens(weighChars(content)));
  });
});

describe("round 5 shapes", () => {
  it("antigravity's wrapped Gemini chunk ends the answer", async () => {
    const completed = [];
    const ts = createPassthroughStreamWithLogger("antigravity", null, "g", "conn", body, (...a) => completed.push(a), "sk-test");
    const writer = ts.writable.getWriter();
    const reader = ts.readable.getReader();
    const drain = (async () => { for (;;) { const { done } = await reader.read(); if (done) break; } })().catch(() => {});
    await writer.write(encoder.encode(`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 } } })}\n\n`));
    ts.finalizeOnAbort();
    await writer.abort(new Error("client went away")).catch(() => {});
    await drain;
    expect(completed[0][3]).toEqual({ aborted: false });
  });

  it("an empty completion with no usage still records the input", async () => {
    const [[, usage]] = await run([
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`, "data: [DONE]\n\n",
    ], "close");
    expect(usage.prompt_tokens).toBe(estimateBillingInputTokens(body));
    expect(usage.completion_tokens).toBe(0);
  });

  it("a normal end drops the pending count through the shared once-only hook", async () => {
    const endPending = vi.fn();
    const completed = [];
    const ts = createPassthroughStreamWithLogger("openai", null, "gpt-x", "conn", body, (...a) => completed.push(a), "sk-test");
    ts.endPending = endPending;
    const writer = ts.writable.getWriter();
    const reader = ts.readable.getReader();
    const drain = (async () => { for (;;) { const { done } = await reader.read(); if (done) break; } })().catch(() => {});
    await writer.write(encoder.encode("data: [DONE]\n\n"));
    await writer.close();
    await drain;
    expect(endPending).toHaveBeenCalledTimes(1);
  });

  it("another provider's usage-only chunk is forwarded (only openai's is ours)", async () => {
    const output = [];
    const usageOnly = `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 } })}\n\n`;
    await run([usageOnly, "data: [DONE]\n\n"], "close", body, { provider: "iflow", output });
    expect(output.join("")).toContain('"choices":[]');
  });
});
