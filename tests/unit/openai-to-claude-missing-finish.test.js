// OpenAI-compatible gateways that end tool-call turns without
// finish_reason: "tool_calls". Snowflake Cortex serving Claude on
// /chat/completions (captured 2026-10-19) streams the tool call, then a usage
// chunk and [DONE], with no finish_reason at all. Claude Code saw end_turn and
// a truncated stream, so it never ran the tool.
import { describe, expect, it } from "vitest";
import { openaiToClaudeResponse } from "../../open-sse/translator/response/openai-to-claude.js";

const state = () => ({ toolCalls: new Map(), nextBlockIndex: 0 });
const chunk = (delta, extra = {}) => ({ id: "", model: "claude-haiku-4-5", choices: [{ index: 0, delta, ...extra }] });
const run = (s, chunks) => chunks.flatMap((c) => openaiToClaudeResponse(c, s) || []);
const stopReason = (events) => events.find((e) => e.type === "message_delta")?.delta.stop_reason;

const TOOL_CHUNKS = [
  chunk({ role: "assistant", tool_calls: [{ index: 0, id: "toolu_1", type: "function", function: { name: "get_weather", arguments: "" } }] }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city": "Paris"}' } }] }),
];

describe("openaiToClaudeResponse without finish_reason", () => {
  it("finishes the message as tool_use when the stream ends with no finish_reason", () => {
    const s = state();
    const events = [...run(s, TOOL_CHUNKS), ...(openaiToClaudeResponse(null, s) || [])];
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
    const events = [...run(s, [chunk({ role: "assistant", content: "Hi" })]), ...(openaiToClaudeResponse(null, s) || [])];
    expect(stopReason(events)).toBe("end_turn");
  });

  it("doesn't send a second message_stop after a real finish_reason", () => {
    const s = state();
    run(s, [...TOOL_CHUNKS, chunk({}, { finish_reason: "tool_calls" })]);
    expect(openaiToClaudeResponse(null, s)).toBeNull();
  });

  it("does nothing on flush when nothing was streamed", () => {
    expect(openaiToClaudeResponse(null, state())).toBeNull();
  });
});
