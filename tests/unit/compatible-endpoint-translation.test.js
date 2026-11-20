// Translation fixes for custom endpoints (PR #89 review): [DONE] ends the
// client stream, Responses streams aren't finished early, and claude->openai
// keeps tool_use/tool_result pairs and tool-result images intact.
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}), saveRequestDetail: vi.fn(async () => {}),
}));

const { createSSETransformStreamWithLogger } = await import("../../open-sse/utils/stream.js");
const { translateRequest, translateResponse, initState } = await import("../../open-sse/translator/index.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");

const enc = new TextEncoder();
const chunk = (delta, extra = {}) => `data: ${JSON.stringify({ id: "chatcmpl-abcdefgh", model: "m", choices: [{ index: 0, delta, ...extra }] })}\n\n`;

describe("[DONE] on a Chat Completions upstream", () => {
  it("emits message_stop and closes the client stream while the socket stays open", async () => {
    const ts = createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.CLAUDE, "openai-compatible-x", null, null, "m", "c", { messages: [] });
    const writer = ts.writable.getWriter();
    const reader = ts.readable.getReader();
    // Never close the writer: an upstream that holds the connection after [DONE].
    writer.write(enc.encode(
      chunk({ role: "assistant", tool_calls: [{ index: 0, id: "toolu_1", type: "function", function: { name: "Read", arguments: '{"file_path":"/a"}' } }] }) +
      "data: [DONE]\n\n"
    ));
    let text = "";
    const dec = new TextDecoder();
    const read = (async () => { for (;;) { const { done, value } = await reader.read(); if (done) return true; text += dec.decode(value); } })();
    const closed = await Promise.race([read, new Promise((r) => setTimeout(() => r(false), 500))]);
    expect(closed).toBe(true);
    expect(text).toContain("\"stop_reason\":\"tool_use\"");
    expect(text).toContain("event: message_stop");
  });
});

describe("Responses upstream -> Claude client", () => {
  const run = (events, { done }) => {
    const state = { ...initState(FORMATS.CLAUDE), toolCalls: new Map(), targetFormat: FORMATS.OPENAI_RESPONSES };
    const out = events.flatMap((e) => translateResponse(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, e, state) || []);
    if (done) state.upstreamDone = true;
    out.push(...(translateResponse(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, null, state) || []));
    return out;
  };
  const toolStart = [
    { type: "response.output_item.added", item: { type: "function_call", call_id: "c1", name: "Write" } },
    { type: "response.function_call_arguments.delta", delta: '{"file_path":"/a","conte' },
  ];
  const stop = (out) => out.find((e) => e.type === "message_delta")?.delta.stop_reason;

  it("leaves a stream cut off before response.completed / [DONE] unfinished", () => {
    const out = run(toolStart, { done: false });
    expect(out.some((e) => e.type === "message_stop")).toBe(false);
  });
  it("maps response.incomplete to max_tokens, not tool_use", () => {
    const out = run([...toolStart, { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }], { done: true });
    expect(stop(out)).toBe("max_tokens");
  });
  it("still finishes a completed tool call as tool_use", () => {
    const out = run([...toolStart, { type: "response.output_item.done", item: { type: "function_call" } }, { type: "response.completed", response: {} }], { done: true });
    expect(stop(out)).toBe("tool_use");
  });
});

describe("claude -> openai request", () => {
  const translate = (messages) => translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI, "m", { model: "m", max_tokens: 10, messages }, false, {}, "openai-compatible-x").messages;

  it("keeps the tool result right after tool_calls when a system message sits between them", () => {
    const out = translate([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
      { role: "system", content: "reminder" },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file body" }] },
    ]);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(out[2]).toMatchObject({ tool_call_id: "t1", content: "file body" });
    expect(out[3].content).toContain("reminder");
  });

  it("sends tool-result images as image parts, not base64 text", () => {
    const out = translate([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Screenshot", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: false, content: [{ type: "text", text: "done" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } }] }] },
    ]);
    const tool = out.find((m) => m.role === "tool");
    expect(tool.content).not.toContain("QUJD");
    const after = out[out.indexOf(tool) + 1];
    expect(after.role).toBe("user");
    expect(after.content).toEqual([{ type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }]);
  });
});

describe("fixMissingToolResponses", async () => {
  const { fixMissingToolResponses } = await import("../../open-sse/translator/concerns/toolCall.js");
  const call = { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "Read", arguments: "{}" } }] };
  it("stubs results when the conversation ends on a system message after tool calls", () => {
    const body = { messages: [{ role: "user", content: "hi" }, call, { role: "system", content: "note" }] };
    fixMissingToolResponses(body);
    expect(body.messages.some((m) => m.role === "tool" && m.tool_call_id === "c1")).toBe(true);
  });
  it("adds nothing when the tool result follows a system message", () => {
    const body = { messages: [call, { role: "system", content: "note" }, { role: "tool", tool_call_id: "c1", content: "ok" }] };
    fixMissingToolResponses(body);
    expect(body.messages.filter((m) => m.role === "tool")).toHaveLength(1);
  });
});
