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

const { createPassthroughStreamWithLogger } = await import("open-sse/utils/stream.js");
const { buildOnStreamComplete } = await import("open-sse/handlers/chatCore/streamingHandler.js");

const encoder = new TextEncoder();
const body = { model: "gpt-x", input: [{ role: "user", content: "please call the tool for me with the right path" }] };

/** Push SSE text through a passthrough stream, then end it the given way. */
async function run(parts, end) {
  const completed = [];
  const ts = createPassthroughStreamWithLogger("codex", null, "gpt-x", "conn", body, (...args) => completed.push(args), "sk-test");
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
    await run([], "abort");
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
