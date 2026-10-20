// OpenAI-compatible gateways that end tool-call turns without
// finish_reason: "tool_calls". Snowflake Cortex serving Claude on
// /chat/completions (captured 2026-10-19) streams the tool call, then a usage
// chunk and [DONE], with no finish_reason at all. Claude Code saw end_turn and
// a truncated stream, so it never ran the tool. stream.js sets
// state.upstreamDone when it sees [DONE]; only then may the flush finish the
// message, so a stream cut off mid-reply is not passed off as complete.
import { describe, expect, it } from "vitest";
import { openaiToClaudeResponse } from "../../open-sse/translator/response/openai-to-claude.js";

const state = () => ({ toolCalls: new Map(), nextBlockIndex: 0 });
const chunk = (delta, extra = {}) => ({ id: "", model: "claude-haiku-4-5", choices: [{ index: 0, delta, ...extra }] });
const run = (s, chunks) => chunks.flatMap((c) => openaiToClaudeResponse(c, s) || []);
// What stream.js does on "data: [DONE]" and then at end of stream.
const endClean = (s) => { s.upstreamDone = true; return openaiToClaudeResponse(null, s) || []; };
const stopReason = (events) => events.find((e) => e.type === "message_delta")?.delta.stop_reason;

const TOOL_CHUNKS = [
  chunk({ role: "assistant", tool_calls: [{ index: 0, id: "toolu_1", type: "function", function: { name: "get_weather", arguments: "" } }] }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city": "Paris"}' } }] }),
];

describe("openaiToClaudeResponse without finish_reason", () => {
  it("finishes the message as tool_use when the stream ends with [DONE] and no finish_reason", () => {
    const s = state();
    const events = [...run(s, TOOL_CHUNKS), ...endClean(s)];
    expect(stopReason(events)).toBe("tool_use");
    expect(events.at(-1).type).toBe("message_stop");
    const args = events.find((e) => e.delta?.type === "input_json_delta")?.delta.partial_json;
    expect(JSON.parse(args)).toEqual({ city: "Paris" });
  });

  it("uses tool_use when the gateway says stop but sent tool calls", () => {
    const s = state();
    const events = run(s, [...TOOL_CHUNKS, chunk({}, { finish_reason: "stop" })]);
    expect(stopReason(events)).toBe("tool_use");
  });

  it("keeps end_turn for a plain text reply", () => {
    const s = state();
    const events = [...run(s, [chunk({ role: "assistant", content: "Hi" })]), ...endClean(s)];
    expect(stopReason(events)).toBe("end_turn");
  });

  it("doesn't send a second message_stop after a real finish_reason", () => {
    const s = state();
    run(s, [...TOOL_CHUNKS, chunk({}, { finish_reason: "tool_calls" })]);
    expect(endClean(s)).toEqual([]);
  });

  it("does nothing on flush when nothing was streamed", () => {
    expect(endClean(state())).toEqual([]);
  });

  it("leaves a stream cut off before [DONE] unfinished", () => {
    const s = state();
    run(s, TOOL_CHUNKS);
    expect(openaiToClaudeResponse(null, s)).toBeNull();
  });
});

describe("openaiToClaudeResponse finish mapping", () => {
  it("keeps max_tokens when a tool call is cut off by length", () => {
    const s = state();
    const events = run(s, [...TOOL_CHUNKS, chunk({}, { finish_reason: "length" })]);
    expect(stopReason(events)).toBe("max_tokens");
  });

  it("keeps parallel tool calls apart when deltas carry no index", () => {
    const s = state();
    const events = run(s, [
      chunk({ tool_calls: [{ id: "a", type: "function", function: { name: "Read", arguments: "" } }] }),
      chunk({ tool_calls: [{ function: { arguments: '{"file_path":"/a"}' } }] }),
      chunk({ tool_calls: [{ id: "b", type: "function", function: { name: "Read", arguments: '{"file_path":"/b"}' } }] }),
      chunk({}, { finish_reason: "tool_calls" }),
    ]);
    const starts = events.filter((e) => e.type === "content_block_start").map((e) => e.content_block.id);
    expect(starts).toEqual(["a", "b"]);
    const args = events.filter((e) => e.delta?.type === "input_json_delta").map((e) => JSON.parse(e.delta.partial_json));
    expect(args).toEqual([{ file_path: "/a" }, { file_path: "/b" }]);
  });
});

describe("non-streaming finish mapping", () => {
  const reply = (finish_reason) => ({ id: "x", choices: [{ message: { role: "assistant", tool_calls: [{ id: "t", type: "function", function: { name: "Write", arguments: '{"file_path":"/a","conte' } }] }, finish_reason }] });
  it("length with a tool call stays max_tokens; stop or none is tool_use", async () => {
    const { translateNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
    expect(translateNonStreamingResponse(reply("length"), "openai", "claude").stop_reason).toBe("max_tokens");
    expect(translateNonStreamingResponse(reply("stop"), "openai", "claude").stop_reason).toBe("tool_use");
    expect(translateNonStreamingResponse(reply(null), "openai", "claude").stop_reason).toBe("tool_use");
  });
});
