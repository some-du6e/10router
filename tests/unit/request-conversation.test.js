import { describe, expect, it } from "vitest";
import {
  getRequestConversation,
  getConversation,
  structuredPreview,
} from "../../src/shared/utils/requestConversation.js";
import { __test__ } from "../../src/lib/db/repos/requestDetailsRepo.js";

describe("request conversation inspector", () => {
  it("appends recorded response reasoning and tool calls after client messages", () => {
    const response = {
      content: "Checking the files",
      thinking: "Read the inventory first",
      tool_calls: [{ type: "function_call", name: "exec_command", arguments: '{"cmd":"pwd"}' }],
    };
    const { messages } = getConversation({ input: "Make a report" }, response);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
    expect(messages.map((m) => m.index)).toEqual([0, 1, 2]);
    expect(messages[1].name).toBe("Response: Reasoning");
    expect(messages[1].text).toBe(response.thinking);
    expect(messages[2].text).toContain('Tool call: exec_command\n{"cmd":"pwd"}');
    expect(messages[2].text).toContain(response.content);
    expect(messages[2].raw.tool_calls).toEqual(response.tool_calls);
  });

  it("reads structured response previews and keeps redacted responses private", () => {
    const request = { input: "Hello" };
    expect(getConversation(request, { _truncated: true, _structuredPreview: { content: "Partial reply" } }).messages[1].text).toBe("Partial reply");
    expect(getConversation(request, { redacted: true, content: "secret" }).messages).toHaveLength(1);
    expect(getConversation({ redacted: true }, { content: "secret" }).messages).toEqual([]);
    expect(getConversation(request, { content: "", thinking: null, tool_calls: [] }).messages).toHaveLength(1);
    expect(getConversation(request, { _truncated: true, _preview: "fragment" }).messages[1].text).toContain("Response truncated");
  });

  it("labels real Codex reasoning and custom tool traffic correctly", () => {
    const { messages } = getRequestConversation({
      input: [
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Checking the inventory" }],
          encrypted_content: "opaque",
        },
        { type: "reasoning", summary: [], encrypted_content: "opaque" },
        {
          type: "custom_tool_call",
          name: "apply_patch",
          input: "*** Begin Patch",
          call_id: "call_patch",
        },
        {
          type: "custom_tool_call_output",
          call_id: "call_patch",
          output: "Updated report.json",
        },
      ],
    });
    expect(messages.map((m) => m.role)).toEqual([
      "assistant",
      "assistant",
      "assistant",
      "tool",
    ]);
    expect(messages[0].text).toBe("Checking the inventory");
    expect(messages[1].text).toBe("[Reasoning content not available]");
    expect(messages[2].text).toContain(
      "Tool call: apply_patch\n*** Begin Patch",
    );
    expect(messages[3].text).toBe("Updated report.json");
    expect(messages[3].name).toBe("call_patch");
    expect(messages[0].text).not.toContain("opaque");
  });
  it("keeps system prompts, assistant tool calls, results and tool schemas", () => {
    const result = getRequestConversation({
      messages: [
        { role: "system", content: "Be concise" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              function: { name: "search", arguments: '{"query":"hello"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "Found it" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "search",
            description: "Search files",
            parameters: { type: "object" },
          },
        },
      ],
    });
    expect(result.messages.map((m) => m.role)).toEqual([
      "system",
      "assistant",
      "tool",
    ]);
    expect(result.messages[1].text).toContain(
      'Tool call: search\n{"query":"hello"}',
    );
    expect(result.messages[2].name).toBe("call_1");
    expect(result.tools[0].text).toContain("Search files");
    expect(result.tools[0].raw.function.parameters).toEqual({ type: "object" });
  });

  it("reads Responses API instructions, calls and output in order", () => {
    const { messages } = getRequestConversation({
      instructions: "Rules",
      input: [
        { role: "user", content: [{ type: "input_text", text: "Hello" }] },
        { type: "function_call", name: "lookup", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "Done" },
      ],
    });
    expect(messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
    ]);
    expect(messages[1].text).toBe("Hello");
    expect(messages[3].text).toBe("Done");
  });

  it("separates Claude tool results from user text and preserves thinking", () => {
    const { messages } = getRequestConversation({
      system: [{ type: "text", text: "Rules" }],
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Reasoning" },
            {
              type: "tool_use",
              id: "c1",
              name: "read",
              input: { path: "file" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "c1",
              content: [{ type: "text", text: "File content" }],
            },
            { type: "text", text: "Next" },
          ],
        },
      ],
    });
    expect(messages.map((m) => m.role)).toEqual([
      "system",
      "assistant",
      "user",
      "tool",
    ]);
    expect(messages[1].text).toContain("Reasoning");
    expect(messages[3].text).toContain("File content");
  });

  it("reads Gemini roles, system instruction and function declarations", () => {
    const { messages, tools } = getRequestConversation({
      systemInstruction: { parts: [{ text: "Rules" }] },
      contents: [
        {
          role: "model",
          parts: [{ functionCall: { name: "read", args: {} } }],
        },
        {
          role: "user",
          parts: [
            { functionResponse: { name: "read", response: { text: "Done" } } },
          ],
        },
      ],
      tools: [
        {
          functionDeclarations: [
            { name: "read", parameters: { type: "OBJECT" } },
          ],
        },
      ],
    });
    expect(messages.map((m) => m.role)).toEqual([
      "system",
      "assistant",
      "tool",
    ]);
    expect(tools[0].name).toBe("read");
  });

  it("does not interpret redacted or old truncated previews as messages", () => {
    expect(
      getRequestConversation({
        redacted: true,
        messages: [{ role: "user", content: "secret" }],
      }).messages,
    ).toEqual([]);
    expect(
      getRequestConversation({ _truncated: true, _preview: '{"messages":[' })
        .messages,
    ).toEqual([]);
  });

  it("retains navigable message structure for oversized stored requests", () => {
    const request = {
      messages: Array.from({ length: 200 }, (_, index) => ({
        role: index % 2 ? "assistant" : "user",
        content: "x".repeat(6000),
      })),
      tools: [
        {
          type: "function",
          function: { name: "read", parameters: { type: "object" } },
        },
      ],
    };
    const stored = __test__.truncateField(request, 128 * 1024);
    expect(stored._truncated).toBe(true);
    expect(JSON.stringify(stored).length).toBeLessThanOrEqual(128 * 1024);
    const { messages, tools } = getRequestConversation(stored);
    expect(messages).toHaveLength(200);
    expect(messages[199].role).toBe("assistant");
    expect(messages[0].text).toContain("[Content truncated]");
    expect(tools[0].name).toBe("read");
    expect(request.messages[0].content).toHaveLength(6000);
  });

  it("falls back when structural overhead exceeds the budget", () => {
    expect(
      structuredPreview(
        {
          messages: Array.from({ length: 1000 }, () => ({
            role: "user",
            content: "hello",
          })),
        },
        1024,
      ),
    ).toBeNull();
  });

  it("accounts for escaped strings in the storage budget", () => {
    const request = {
      messages: [{ role: "user", content: '\\"\n'.repeat(10000) }],
    };
    const stored = __test__.truncateField(request, 1024);
    expect(JSON.stringify(stored).length).toBeLessThanOrEqual(1024);
  });
});
