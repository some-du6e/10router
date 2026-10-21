import { describe, expect, it } from "vitest";
import {
  openaiResponsesToOpenAIRequest,
  openaiToOpenAIResponsesRequest,
} from "../../open-sse/translator/request/openai-responses.js";
import { openaiToOpenAIResponsesResponse } from "../../open-sse/translator/response/openai-responses.js";
import { initState, translateRequest, translateResponse } from "../../open-sse/translator/index.js";
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

describe("namespace survives the full openai-responses → claude → client chain", () => {
  const REQUEST = {
    model: "claude-opus-5",
    stream: true,
    input: [
      { type: "additional_tools", role: "developer", tools: [NAMESPACE_TOOLS] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "run pwd" }] },
    ],
  };

  // openaiToClaudeRequest builds a fresh body field-by-field, so translator-only
  // metadata set on the OpenAI intermediate is dropped unless translateRequest
  // carries it across the pivot. Without that the client gets a namespaced tool
  // call with no namespace and rejects it.
  it("carries _toolNamespaces through the openai pivot to the claude body", () => {
    const out = translateRequest(
      FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, "claude-opus-5",
      structuredClone(REQUEST), true, {}, "claude", null, [], null, null,
    );

    expect(out.tools.map((t) => t.name)).toEqual(["exec_ide", "read_file"]);
    expect(out._toolNamespaces).toEqual({ exec_ide: "functions", read_file: "functions" });
  });

  it("emits the namespace on a tool call translated back from claude SSE", () => {
    const req = translateRequest(
      FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, "claude-opus-5",
      structuredClone(REQUEST), true, {}, "claude", null, [], null, null,
    );
    // Mirrors how chatCore seeds the response state from the translated request.
    const state = {
      ...initState(FORMATS.OPENAI_RESPONSES),
      customToolNames: new Set(req._customToolNames || []),
      toolNamespaces: new Map(Object.entries(req._toolNamespaces || {})),
    };

    const chunks = [
      { type: "message_start", message: { id: "m1", model: "claude-opus-5", usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "exec_ide", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"cmd\":\"pwd\"}" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ];
    const events = [];
    for (const c of chunks) events.push(...(translateResponse(FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, c, state) || []));

    const items = events.filter((e) => String(e.event || "").includes("output_item"));
    expect(items.length).toBeGreaterThan(0);
    for (const e of items) {
      expect(e.data.item.name).toBe("exec_ide");
      expect(e.data.item.namespace).toBe("functions");
    }
  });
});

describe("tool names shared across namespaces", () => {
  const fn = (name) => ({ type: "function", name, description: name, parameters: { type: "object", properties: {} } });
  // Shape of the Codex request that Anthropic rejected with "Tool names must be unique."
  const TOOLS = [
    fn("exec_command"),
    { type: "namespace", name: "mcp__codex_apps__github", description: "", tools: [fn("_fetch"), fn("_search"), fn("_add_reaction_to_pr")] },
    { type: "namespace", name: "mcp__codex_apps__notion", description: "", tools: [fn("_fetch"), fn("_search")] },
  ];
  const REQUEST = {
    model: "claude-opus-5",
    stream: true,
    tools: TOOLS,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "find the doc" }] }],
  };

  it("sends every tool to claude under a unique name", () => {
    const out = translateRequest(
      FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, "claude-opus-5",
      structuredClone(REQUEST), true, {}, "claude", null, [], null, null,
    );
    const names = out.tools.map((t) => t.name);

    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([
      "exec_command",
      "mcp__codex_apps__github_fetch",
      "mcp__codex_apps__github_search",
      "_add_reaction_to_pr",
      "mcp__codex_apps__notion_fetch",
      "mcp__codex_apps__notion_search",
    ]);
    for (const n of names) expect(n).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  it("drops a tool re-declared in the same namespace", () => {
    const out = openaiResponsesToOpenAIRequest("claude-opus-5", {
      tools: [TOOLS[1]],
      input: [
        { type: "additional_tools", role: "developer", tools: [TOOLS[1]] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
    }, true, null);

    expect(out.tools.map((t) => t.function.name)).toEqual(["_fetch", "_search", "_add_reaction_to_pr"]);
  });

  it("caps qualified names at 64 characters and keeps them distinct", () => {
    const longNs = `mcp__${"x".repeat(70)}`;
    const out = openaiResponsesToOpenAIRequest("claude-opus-5", {
      tools: [
        { type: "namespace", name: `${longNs}a`, tools: [fn("_fetch")] },
        { type: "namespace", name: `${longNs}b`, tools: [fn("_fetch")] },
      ],
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    }, true, null);
    const names = out.tools.map((t) => t.function.name);

    expect(new Set(names).size).toBe(2);
    for (const n of names) expect(n.length).toBeLessThanOrEqual(64);
  });

  it("renames a prior turn's call to the qualified name", () => {
    const out = openaiResponsesToOpenAIRequest("claude-opus-5", {
      tools: TOOLS,
      input: [
        { type: "function_call", call_id: "call_1", name: "_fetch", namespace: "mcp__codex_apps__notion", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "doc" },
      ],
    }, true, null);
    const call = out.messages.find((m) => m.tool_calls).tool_calls[0];

    expect(call.function.name).toBe("mcp__codex_apps__notion_fetch");
    expect(out._toolNamespaces._fetch).toBeUndefined();
  });

  it("hands the client back the original name and namespace", () => {
    const req = translateRequest(
      FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, "claude-opus-5",
      structuredClone(REQUEST), true, {}, "claude", null, [], null, null,
    );
    const state = {
      ...initState(FORMATS.OPENAI_RESPONSES),
      customToolNames: new Set(req._customToolNames || []),
      toolNamespaces: new Map(Object.entries(req._toolNamespaces || {})),
    };
    const chunks = [
      { type: "message_start", message: { id: "m1", model: "claude-opus-5", usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "mcp__codex_apps__notion_fetch", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ];
    const events = [];
    for (const c of chunks) events.push(...(translateResponse(FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, c, state) || []));
    const items = events.filter((e) => String(e.event || "").includes("output_item"));

    expect(items.length).toBeGreaterThan(0);
    for (const e of items) {
      expect(e.data.item.name).toBe("_fetch");
      expect(e.data.item.namespace).toBe("mcp__codex_apps__notion");
    }
  });
});
