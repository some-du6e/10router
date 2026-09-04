import { describe, expect, it } from "vitest";
import {
  openaiResponsesToOpenAIRequest,
  openaiToOpenAIResponsesRequest,
} from "../../open-sse/translator/request/openai-responses.js";
import { openaiToOpenAIResponsesResponse } from "../../open-sse/translator/response/openai-responses.js";
import { initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const NAMESPACE_TOOLS = {
  type: "namespace",
  name: "functions",
  description: "",
  tools: [
    {
      type: "function",
      name: "exec_ide",
      description: "Run a shell command",
      parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
    },
    {
      type: "function",
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
  ],
};

function translate(tools) {
  return openaiResponsesToOpenAIRequest("claude-opus-5", {
    input: [
      { type: "additional_tools", role: "developer", tools },
      { type: "message", role: "user", content: [{ type: "input_text", text: "run pwd" }] },
    ],
    tool_choice: "auto",
  }, true, null);
}

describe("Responses namespace tools → OpenAI Chat", () => {
  it("flattens namespace containers into their nested function tools", () => {
    const out = translate([NAMESPACE_TOOLS]);

    // Before the fix the container itself leaked through as a single nameless-schema
    // "functions" tool and every real tool was dropped.
    expect(out.tools.map((t) => t.function.name)).toEqual(["exec_ide", "read_file"]);
    expect(out.tools[0].function.parameters).toEqual({
      type: "object",
      properties: { cmd: { type: "string" } },
      required: ["cmd"],
    });
  });

  it("records the namespace of each flattened tool", () => {
    const out = translate([NAMESPACE_TOOLS]);

    expect(out._toolNamespaces).toEqual({ exec_ide: "functions", read_file: "functions" });
  });

  it("skips defer_loading tools that arrive later via tool search", () => {
    const out = translate([{
      ...NAMESPACE_TOOLS,
      tools: [...NAMESPACE_TOOLS.tools, {
        type: "function",
        name: "deferred",
        parameters: { type: "object", properties: {} },
        defer_loading: true,
      }],
    }]);

    expect(out.tools.map((t) => t.function.name)).toEqual(["exec_ide", "read_file"]);
    expect(out._toolNamespaces.deferred).toBeUndefined();
  });

  it("skips a top-level defer_loading tool declared outside any namespace", () => {
    const out = translate([
      { type: "function", name: "plain", description: "p", parameters: { type: "object", properties: {} } },
      { type: "function", name: "top_deferred", parameters: { type: "object", properties: {} }, defer_loading: true },
    ]);

    expect(out.tools.map((t) => t.function.name)).toEqual(["plain"]);
  });

  it("leaves plain function tools untouched", () => {
    const out = translate([
      { type: "function", name: "plain", description: "p", parameters: { type: "object", properties: {} } },
    ]);

    expect(out.tools.map((t) => t.function.name)).toEqual(["plain"]);
    expect(out._toolNamespaces).toBeUndefined();
  });

  it("carries the namespace of a prior turn's function_call", () => {
    const out = openaiResponsesToOpenAIRequest("claude-opus-5", {
      input: [
        { type: "function_call", call_id: "call_1", name: "exec_ide", namespace: "functions", arguments: "{\"cmd\":\"pwd\"}" },
        { type: "function_call_output", call_id: "call_1", output: "/tmp" },
      ],
    }, true, null);

    expect(out._toolNamespaces).toEqual({ exec_ide: "functions" });
  });
});

describe("OpenAI Chat → Responses namespace round-trip", () => {
  it("restores the namespace when replaying a tool call", () => {
    const out = openaiToOpenAIResponsesRequest("claude-opus-5", {
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_1",
            type: "function",
            namespace: "functions",
            function: { name: "exec_ide", arguments: "{\"cmd\":\"pwd\"}" },
          }],
        },
      ],
    }, true, null);

    const call = out.input.find((i) => i.type === "function_call");
    expect(call.namespace).toBe("functions");
  });

  it("omits namespace for calls that never had one", () => {
    const out = openaiToOpenAIResponsesRequest("claude-opus-5", {
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "plain", arguments: "{}" } }],
        },
      ],
    }, true, null);

    expect(out.input.find((i) => i.type === "function_call").namespace).toBeUndefined();
  });
});

describe("Responses namespace tools ← streamed tool call", () => {
  function streamCall(toolNamespaces) {
    const state = {
      ...initState(FORMATS.OPENAI_RESPONSES),
      customToolNames: new Set(),
      toolNamespaces: new Map(Object.entries(toolNamespaces)),
    };
    const events = [];
    const chunks = [
      { id: "c1", model: "m", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "exec_ide", arguments: "{\"cmd\":" } }] } }] },
      { id: "c1", model: "m", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "\"pwd\"}" } }] } }] },
      { id: "c1", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ];
    for (const chunk of chunks) events.push(...(openaiToOpenAIResponsesResponse(chunk, state) || []));
    return events.filter((e) => e.event === "response.output_item.added" || e.event === "response.output_item.done");
  }

  it("attaches the namespace to the emitted function_call items", () => {
    const items = streamCall({ exec_ide: "functions" });

    expect(items).toHaveLength(2);
    for (const e of items) {
      expect(e.data.item.name).toBe("exec_ide");
      // Clients resolve a namespaced tool by this field; without it the call is
      // rejected as `unsupported call: exec_ide`.
      expect(e.data.item.namespace).toBe("functions");
    }
  });

  it("omits the namespace for tools declared outside one", () => {
    for (const e of streamCall({})) expect(e.data.item.namespace).toBeUndefined();
  });
});
