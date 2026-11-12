// A Codex request with MCP namespaces whose tools share short names, sent to a
// Claude model behind a Chat Completions endpoint or an Anthropic-compatible one.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { initState, translateRequest, translateResponse } = await import("../../open-sse/translator/index.js");
const { translateNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
const { handleForcedSSEToJson } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");

const MODEL = "claude-opus-5-5";
const WIRE_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const PATCH = "*** Begin Patch\n*** Add File: hello.txt\n+hi\n*** End Patch\n";

const schema = (props = {}) => ({ type: "object", properties: props, additionalProperties: false });
const fn = (name, props) => ({ type: "function", name, description: `${name} tool`, strict: false, parameters: schema(props) });
const ns = (name, tools) => ({ type: "namespace", name, description: `${name} server`, tools });

// The tool list Codex sent when the upstream answered "tools: Tool names must be unique."
function codexTools(nsSuffix = "") {
  return [
    fn("exec_command", { cmd: { type: "string" } }),
    fn("write_stdin", { session_id: { type: "number" }, chars: { type: "string" } }),
    fn("list_mcp_resources"),
    fn("list_mcp_resource_templates"),
    fn("read_mcp_resource", { server: { type: "string" }, uri: { type: "string" } }),
    fn("update_plan"),
    fn("get_goal"),
    fn("create_goal"),
    fn("update_goal"),
    fn("request_user_input"),
    {
      type: "custom",
      name: "apply_patch",
      description: "Use the `apply_patch` tool to edit files.",
      format: { type: "grammar", syntax: "lark", definition: "start: begin_patch hunk+ end_patch" },
    },
    fn("view_image", { path: { type: "string" } }),
    fn("spawn_agent"),
    fn("send_message"),
    fn("followup_task"),
    fn("wait_agent"),
    fn("close_agent"),
    fn("list_agents"),
    { type: "web_search", external_web_access: true },
    ns(`mcp__cua_repl${nsSuffix}`, [fn("js", { code: { type: "string" } }), fn("js_reset")]),
    ns(`mcp__node_repl${nsSuffix}`, [fn("js", { code: { type: "string" } }), fn("js_add_node_module_dir", { dir: { type: "string" } }), fn("js_reset")]),
  ];
}

const TOP_LEVEL = [
  "exec_command", "write_stdin", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource",
  "update_plan", "get_goal", "create_goal", "update_goal", "request_user_input", "apply_patch", "view_image",
  "spawn_agent", "send_message", "followup_task", "wait_agent", "close_agent", "list_agents",
];

const userTurn = (text) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });

function codexRequest({ input = [userTurn("reset the node repl")], nsSuffix = "", stream = true } = {}) {
  return {
    model: MODEL,
    instructions: "You are Codex.",
    stream,
    store: false,
    tool_choice: "auto",
    parallel_tool_calls: true,
    tools: codexTools(nsSuffix),
    input,
  };
}

// The two routes a Claude model behind a custom endpoint takes.
const ROUTES = [
  { label: "Chat Completions endpoint", target: FORMATS.OPENAI, provider: "openai-compatible-chat-acme" },
  { label: "Anthropic-compatible endpoint", target: FORMATS.CLAUDE, provider: "anthropic-compatible-acme" },
];

function translate(route, request = codexRequest()) {
  return translateRequest(
    FORMATS.OPENAI_RESPONSES, route.target, MODEL, structuredClone(request), request.stream,
    { apiKey: "key-a" }, route.provider, null, [], null, null,
  );
}

const toolName = (tool) => tool.function?.name ?? tool.name;

// How chatCore and stream.js seed the response state from the translated request.
function responsesState(req) {
  return {
    ...initState(FORMATS.OPENAI_RESPONSES),
    customToolNames: new Set(req._customToolNames || []),
    toolNamespaces: new Map(Object.entries(req._toolNamespaces || {})),
  };
}

function claudeToolUseStream(name, inputJson) {
  return [
    { type: "message_start", message: { id: "msg_1", model: MODEL, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name, input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: inputJson } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ];
}

function chatToolCallStream(name, argumentsJson) {
  return [
    { id: "chatcmpl-1", model: MODEL, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name, arguments: "" } }] } }] },
    { id: "chatcmpl-1", model: MODEL, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argumentsJson } }] } }] },
    { id: "chatcmpl-1", model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
}

// The upstream calls `wireName`; return the output items Codex receives.
function streamCall(route, req, wireName, args) {
  const state = responsesState(req);
  const chunks = route.target === FORMATS.CLAUDE ? claudeToolUseStream(wireName, args) : chatToolCallStream(wireName, args);
  const events = [];
  for (const chunk of chunks) events.push(...(translateResponse(route.target, FORMATS.OPENAI_RESPONSES, chunk, state) || []));
  const done = events.filter((e) => e.event === "response.output_item.done").map((e) => e.data.item);
  const added = events.filter((e) => e.event === "response.output_item.added").map((e) => e.data.item);
  const completed = events.find((e) => e.event === "response.completed")?.data?.response?.output || [];
  return { done, added, completed };
}

function nonStreamCall(route, req, wireName, args) {
  const callId = route.target === FORMATS.CLAUDE ? "toolu_1" : "call_1";
  const body = route.target === FORMATS.CLAUDE
    ? {
      id: "msg_1", type: "message", role: "assistant", model: MODEL,
      content: [{ type: "tool_use", id: callId, name: wireName, input: JSON.parse(args) }],
      stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 3 },
    }
    : {
      id: "chatcmpl-1", object: "chat.completion", model: MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: callId, type: "function", function: { name: wireName, arguments: args } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
    };
  // chatCore hands these over exactly as the request translator left them.
  const out = translateNonStreamingResponse(body, route.target, FORMATS.OPENAI_RESPONSES, req._customToolNames, req._toolNamespaces);
  return { out, callId };
}

describe("Codex MCP namespaces with shared tool names", () => {
  describe.each(ROUTES)("$label", (route) => {
    it("declares every tool upstream under a unique, valid name", () => {
      const names = translate(route).tools.map(toolName);

      expect(new Set(names).size).toBe(names.length);
      for (const n of names) {
        expect(n).toMatch(WIRE_NAME);
        expect(n).not.toContain("::");
        expect(n).not.toContain(".");
      }
      expect(names).toEqual(expect.arrayContaining([
        ...TOP_LEVEL,
        "mcp__cua_repl__js", "mcp__cua_repl__js_reset",
        "mcp__node_repl__js", "mcp__node_repl__js_reset",
        "js_add_node_module_dir",
      ]));
      expect(names).toHaveLength(TOP_LEVEL.length + 5);
    });

    it("qualifies a namespace that already ends in a separator without doubling it", () => {
      const names = translate(route, codexRequest({ nsSuffix: "__" })).tools.map(toolName);

      expect(new Set(names).size).toBe(names.length);
      expect(names).toEqual(expect.arrayContaining(["mcp__node_repl__js", "mcp__cua_repl__js_reset"]));
    });

    it("streams a qualified call back as a function_call with the original name and namespace", () => {
      const req = translate(route);
      const { done, added, completed } = streamCall(route, req, "mcp__node_repl__js_reset", "{}");
      const callId = route.target === FORMATS.CLAUDE ? "toolu_1" : "call_1";
      const expected = {
        id: `fc_${callId}`,
        type: "function_call",
        arguments: "{}",
        call_id: callId,
        name: "js_reset",
        namespace: "mcp__node_repl",
      };

      expect(done).toEqual([expected]);
      expect(added).toEqual([{ ...expected, arguments: "" }]);
      expect(completed).toEqual([expected]);
    });

    it("streams a call to a namespaced tool that kept its name with its namespace", () => {
      const req = translate(route);
      const { done } = streamCall(route, req, "js_add_node_module_dir", "{\"dir\":\"/tmp\"}");

      expect(done).toHaveLength(1);
      expect(done[0]).toMatchObject({ type: "function_call", name: "js_add_node_module_dir", namespace: "mcp__node_repl", arguments: "{\"dir\":\"/tmp\"}" });
    });

    it("returns a non-streaming qualified call with the original name and namespace", () => {
      const req = translate(route, codexRequest({ stream: false }));
      const { out, callId } = nonStreamCall(route, req, "mcp__cua_repl__js", "{\"code\":\"1+1\"}");

      expect(out.object).toBe("response");
      expect(out.output).toEqual([{
        type: "function_call",
        id: `fc_${callId}`,
        call_id: callId,
        name: "js",
        namespace: "mcp__cua_repl",
        arguments: "{\"code\":\"1+1\"}",
      }]);
    });

    it("replays earlier namespaced calls under the names the tools are declared with", () => {
      const req = translate(route, codexRequest({
        input: [
          userTurn("run 1+1 in both repls"),
          { type: "function_call", call_id: "call_a", name: "js", namespace: "mcp__cua_repl", arguments: "{\"code\":\"1+1\"}" },
          { type: "function_call", call_id: "call_b", name: "js", namespace: "mcp__node_repl", arguments: "{\"code\":\"1+1\"}" },
          { type: "function_call_output", call_id: "call_a", output: "2" },
          { type: "function_call_output", call_id: "call_b", output: "2" },
          userTurn("now reset them"),
        ],
      }));
      const declared = new Set(req.tools.map(toolName));
      const replayed = route.target === FORMATS.CLAUDE
        ? req.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === "tool_use")
          .map((b) => ({ id: b.id, name: b.name }))
        : req.messages.flatMap((m) => m.tool_calls || []).map((tc) => ({ id: tc.id, name: tc.function.name }));

      expect(replayed).toEqual([
        { id: "call_a", name: "mcp__cua_repl__js" },
        { id: "call_b", name: "mcp__node_repl__js" },
      ]);
      for (const { name } of replayed) expect(declared.has(name)).toBe(true);
    });
  });

  it("returns a forced-SSE JSON reply with the original name and namespace", async () => {
    const req = translate(ROUTES[0], codexRequest({ stream: false }));
    const raw = chatToolCallStream("mcp__node_repl__js", "{\"code\":\"1\"}")
      .map((chunk) => `data: ${JSON.stringify(chunk)}`).concat(["data: [DONE]", ""]).join("\n\n");
    const encoder = new TextEncoder();
    const result = await handleForcedSSEToJson({
      providerResponse: new Response(new ReadableStream({
        start(controller) { controller.enqueue(encoder.encode(raw)); controller.close(); },
      }), { headers: { "content-type": "text/event-stream" } }),
      sourceFormat: FORMATS.OPENAI_RESPONSES,
      targetFormat: FORMATS.OPENAI,
      provider: "openai-compatible-chat-acme",
      model: MODEL,
      body: { model: MODEL, input: [] },
      stream: false,
      requestStartTime: Date.now(),
      connectionId: "conn-a",
      clientRawRequest: { endpoint: "/v1/responses" },
      customToolNames: req._customToolNames,
      toolNamespaces: req._toolNamespaces,
      trackDone: vi.fn(),
      appendLog: vi.fn(),
    });
    const json = await result.response.json();

    expect(json.output).toEqual([expect.objectContaining({
      type: "function_call", call_id: "call_1", name: "js", namespace: "mcp__node_repl", arguments: "{\"code\":\"1\"}",
    })]);
  });
});

describe("Codex apply_patch (freeform custom tool) on a Claude model", () => {
  describe.each(ROUTES)("$label", (route) => {
    it("declares apply_patch as a tool taking one string input", () => {
      const tool = translate(route).tools.find((t) => toolName(t) === "apply_patch");
      const params = route.target === FORMATS.CLAUDE ? tool.input_schema : tool.function.parameters;

      expect(params).toMatchObject({ type: "object", properties: { input: { type: "string" } }, required: ["input"] });
      expect(Object.keys(params.properties)).toEqual(["input"]);
      if (route.target === FORMATS.CLAUDE) expect(tool.type).toBeUndefined();
    });

    it("streams the model's call back as a custom_tool_call with raw text input", () => {
      const req = translate(route);
      const { done, completed } = streamCall(route, req, "apply_patch", JSON.stringify({ input: PATCH }));
      const callId = route.target === FORMATS.CLAUDE ? "toolu_1" : "call_1";
      const expected = { id: `ctc_${callId}`, type: "custom_tool_call", input: PATCH, call_id: callId, name: "apply_patch" };

      expect(done).toEqual([expected]);
      expect(completed).toEqual([expected]);
    });

    it("returns a non-streaming call as a custom_tool_call with raw text input", () => {
      const req = translate(route, codexRequest({ stream: false }));
      const { out, callId } = nonStreamCall(route, req, "apply_patch", JSON.stringify({ input: PATCH }));

      expect(out.output).toEqual([{ type: "custom_tool_call", id: `ctc_${callId}`, call_id: callId, name: "apply_patch", input: PATCH }]);
    });

    it("replays an earlier apply_patch call as the same one-string input", () => {
      const req = translate(route, codexRequest({
        input: [
          userTurn("add hello.txt"),
          { type: "custom_tool_call", call_id: "call_p", name: "apply_patch", input: PATCH },
          { type: "custom_tool_call_output", call_id: "call_p", output: "Success." },
        ],
      }));
      const args = route.target === FORMATS.CLAUDE
        ? req.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((b) => b.type === "tool_use").input
        : JSON.parse(req.messages.find((m) => m.tool_calls).tool_calls[0].function.arguments);

      expect(args).toEqual({ input: PATCH });
    });
  });
});

describe("Codex web_search on a Claude model behind a custom endpoint", () => {
  describe.each(ROUTES)("$label", (route) => {
    it("is dropped, not sent as a function", () => {
      const tools = translate(route).tools;

      expect(tools.some((t) => t.type === "web_search")).toBe(false);
      expect(tools.map(toolName)).not.toContain("web_search");
    });

    it("is dropped even when it carries a name", () => {
      const request = codexRequest();
      request.tools = request.tools.map((t) => (t.type === "web_search" ? { ...t, name: "web_search" } : t));
      const tools = translate(route, request).tools;

      expect(tools.some((t) => t.type === "web_search")).toBe(false);
      expect(tools.map(toolName)).not.toContain("web_search");
    });
  });
});

describe("Codex tool names that would still collide after qualifying", () => {
  describe.each(ROUTES)("$label", (route) => {
    const request = (tools) => ({ ...codexRequest(), tools });

    it("gives each tool its own name when a qualified name is also a plain tool's name", () => {
      const req = translate(route, request([
        ns("mcp__a", [fn("js")]), ns("mcp__a_", [fn("_js")]), ns("mcp__b", [fn("js"), fn("_js")]),
        fn("mcp__a__js"), fn("mcp__b__js"),
      ]));
      const names = req.tools.map(toolName);

      expect(names).toHaveLength(6);
      expect(new Set(names).size).toBe(6);
      for (const n of names) expect(n).toMatch(WIRE_NAME);
    });

    it("gives each tool its own name when its name is not a valid upstream name", () => {
      const req = translate(route, request([
        ns("mcp__docs", [fn("search.v2"), fn("search_v2")]),
        fn("files::read"), fn("files__read"),
        ns("mcp__wiki", [fn("search.v2")]),
      ]));
      const names = req.tools.map(toolName);

      expect(names).toHaveLength(5);
      expect(new Set(names).size).toBe(5);
      for (const n of names) {
        expect(n).toMatch(WIRE_NAME);
        expect(n).not.toContain("::");
        expect(n).not.toContain(".");
      }
    });

    it("maps a sanitized top-level name back to the name Codex declared", () => {
      const req = translate(route, request([fn("files::read"), fn("files__read")]));
      const wire = req.tools.map(toolName).find((n) => n !== "files__read");
      const { done } = streamCall(route, req, wire, "{}");

      expect(done).toHaveLength(1);
      expect(done[0].name).toBe("files::read");
      expect(done[0]).not.toHaveProperty("namespace");
    });

    it("caps a long qualified name and keeps the pair distinct", () => {
      const longNs = `mcp__${"very_long_server_name_".repeat(5)}`;
      const req = translate(route, request([ns(`${longNs}one`, [fn("js")]), ns(`${longNs}two`, [fn("js")])]));
      const names = req.tools.map(toolName);

      expect(new Set(names).size).toBe(2);
      for (const n of names) expect(n).toMatch(WIRE_NAME);
    });
  });
});
