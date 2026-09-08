import { describe, expect, it } from "vitest";
import "../translator/registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const T = (model, input) => translateRequest(
  FORMATS.OPENAI_RESPONSES,
  FORMATS.CLAUDE,
  model,
  { input },
  true,
  null,
  "claude"
);

const userMessage = {
  type: "message",
  role: "user",
  content: [{ type: "input_text", text: "run pwd" }],
};

const assistantMessage = {
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text: "Working on it." }],
};

const functionCall = {
  type: "function_call",
  call_id: "call_1",
  name: "exec_ide",
  arguments: "{\"cmd\":\"pwd\"}",
};

describe("Claude Opus 5 assistant-prefill compatibility", () => {
  it("adds a user continuation after a trailing assistant message", () => {
    const out = T("claude-opus-5", [userMessage, assistantMessage]);

    expect(out.messages.map(message => message.role)).toEqual(["user", "assistant", "user"]);
    expect(out.messages.at(-1).content).toEqual([{ type: "text", text: "Continue." }]);
  });

  it("closes a dangling function call with an interrupted tool result", () => {
    const out = T("claude-opus-5", [userMessage, functionCall]);

    expect(out.messages.map(message => message.role)).toEqual(["user", "assistant", "user"]);
    expect(out.messages.at(-1).content).toEqual([{
      type: "tool_result",
      tool_use_id: "call_1",
      content: "Tool execution was interrupted before a result was returned.",
      is_error: true,
    }]);
  });

  it("leaves a completed function call history ending in user unchanged", () => {
    const output = {
      type: "function_call_output",
      call_id: "call_1",
      output: "/tmp",
    };
    const out = T("claude-opus-5", [userMessage, functionCall, output]);

    expect(out.messages.map(message => message.role)).toEqual(["user", "assistant", "user"]);
    expect(out.messages.at(-1).content).toEqual([{
      type: "tool_result",
      tool_use_id: "call_1",
      content: "/tmp",
    }]);
  });

  it("does not change prefill behavior for models that still support it", () => {
    const out = T("claude-opus-4-20250514", [userMessage, assistantMessage]);

    expect(out.messages.map(message => message.role)).toEqual(["user", "assistant"]);
    expect(out.messages.at(-1).content).toEqual([{ type: "text", text: "Working on it.", cache_control: { type: "ephemeral" } }]);
  });

  it("drops an empty Opus 5 prefill instead of inventing an empty turn", () => {
    const emptyAssistant = { type: "message", role: "assistant", content: [] };
    const out = T("claude-opus-5", [userMessage, emptyAssistant]);

    expect(out.messages).toEqual([{
      role: "user",
      content: [{ type: "text", text: "run pwd" }],
    }]);
  });

  it("generates an ID before repairing a dangling ID-less Claude tool_use", () => {
    const out = translateRequest(
      FORMATS.CLAUDE,
      FORMATS.CLAUDE,
      "claude-opus-5",
      {
        model: "claude-opus-5",
        messages: [
          { role: "user", content: [{ type: "text", text: "run it" }] },
          { role: "assistant", content: [{ type: "tool_use", name: "exec_ide", input: {} }] },
        ],
      },
      true,
      null,
      "claude"
    );

    const toolUse = out.messages.at(-2).content[0];
    expect(toolUse.id).toMatch(/^call_msg1_tc0_exec_ide$/);
    expect(out.messages.at(-1).content).toEqual([expect.objectContaining({
      type: "tool_result",
      tool_use_id: toolUse.id,
      is_error: true,
    })]);
  });

  it("matches vendor-prefixed Opus 5 model ids", () => {
    const out = T("anthropic/claude-opus-5-thinking", [userMessage, assistantMessage]);

    expect(out.messages.at(-1).role).toBe("user");
  });
});
