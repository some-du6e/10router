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
const { takeToolMetadata } = await import("../../open-sse/translator/concerns/toolNamespace.js");
const { openaiResponsesToOpenAIRequest, openaiToOpenAIResponsesRequest } = await import("../../open-sse/translator/request/openai-responses.js");
const { jsonReplyToSse } = await import("../../open-sse/handlers/chatCore/jsonToSse.js");
const { relaxForcedToolChoiceForThinking, relaxForcedChatToolChoiceForClaude } = await import("../../open-sse/translator/concerns/toolChoice.js");

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

// How chatCore pulls the metadata off the translated request, and stream.js seeds the state with it.
function responsesState(req) {
  return { ...initState(FORMATS.OPENAI_RESPONSES), ...takeToolMetadata(req) };
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

function nonStreamCall(route, req, wireName, args, finish = null) {
  const callId = route.target === FORMATS.CLAUDE ? "toolu_1" : "call_1";
  const body = route.target === FORMATS.CLAUDE
    ? {
      id: "msg_1", type: "message", role: "assistant", model: MODEL,
      content: [{ type: "tool_use", id: callId, name: wireName, input: JSON.parse(args) }],
      stop_reason: finish || "tool_use", usage: { input_tokens: 1, output_tokens: 3 },
    }
    : {
      id: "chatcmpl-1", object: "chat.completion", model: MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: callId, type: "function", function: { name: wireName, arguments: args } }] }, finish_reason: finish || "tool_calls" }],
      usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
    };
  const { customToolNames, toolNamespaces } = takeToolMetadata(req);
  const out = translateNonStreamingResponse(body, route.target, FORMATS.OPENAI_RESPONSES, customToolNames, toolNamespaces);
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
      ...takeToolMetadata(req),
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

      expect(wire).toMatch(WIRE_NAME);

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

    it("drops tools whose name is blank", () => {
      const names = translate(route, request([fn(" "), fn(""), ns("mcp__a", [fn("\t")]), fn("shell")])).tools.map(toolName);

      expect(names).toEqual(["shell"]);
    });
  });
});

describe("Codex history replay", () => {
  const request = (tools, input) => ({ ...codexRequest(), tools, input });

  it("drops the namespace from a renamed call, so a Chat → Responses hop replays it flat", () => {
    const chat = openaiResponsesToOpenAIRequest(MODEL, request(codexTools(), [
      userTurn("run it"),
      { type: "function_call", call_id: "call_a", name: "js", namespace: "mcp__node_repl", arguments: "{}" },
      { type: "function_call", call_id: "call_b", name: "js_add_node_module_dir", namespace: "mcp__node_repl", arguments: "{}" },
      { type: "function_call_output", call_id: "call_a", output: "ok" },
      { type: "function_call_output", call_id: "call_b", output: "ok" },
    ]), true, null);
    const calls = chat.messages.flatMap((m) => m.tool_calls || []);

    expect(calls[0]).not.toHaveProperty("namespace");
    expect(calls[0].function.name).toBe("mcp__node_repl__js");
    // A call that kept its name keeps its namespace.
    expect(calls[1].namespace).toBe("mcp__node_repl");

    // How the github and zed executors send a Chat body to a Responses upstream.
    const replayed = openaiToOpenAIResponsesRequest(MODEL, chat, true, null).input.filter((i) => i.type === "function_call");
    expect(replayed[0]).toMatchObject({ name: "mcp__node_repl__js" });
    expect(replayed[0]).not.toHaveProperty("namespace");
    expect(replayed[1]).toMatchObject({ name: "js_add_node_module_dir", namespace: "mcp__node_repl" });
  });

  describe.each(ROUTES)("$label", (route) => {
    const custom = (name) => ({ type: "custom", name, description: name, format: { type: "text" } });
    const TOOLS = [fn("run"), ns("mcp__x", [custom("run")])];

    it.each([
      ["with its namespace", { namespace: "mcp__x" }],
      ["without a namespace", {}],
    ])("keeps a plain function call plain after an earlier custom call of the same name %s", (_label, extra) => {
      const req = translate(route, request(TOOLS, [
        userTurn("go"),
        { type: "custom_tool_call", call_id: "call_c", name: "run", input: "x", ...extra },
        { type: "custom_tool_call_output", call_id: "call_c", output: "ok" },
      ]));
      const names = req.tools.map(toolName);

      expect(names).toEqual(["run", "mcp__x__run"]);
      expect(req._customToolNames).toEqual(["mcp__x__run"]);
      const { done } = streamCall(route, req, "run", "{}");
      expect(done[0]).toMatchObject({ type: "function_call", name: "run", arguments: "{}" });
      expect(done[0]).not.toHaveProperty("namespace");
    });

    it("still returns a custom call to a tool only an earlier turn declared", () => {
      const req = translate(route, request([fn("shell")], [
        userTurn("go"),
        { type: "custom_tool_call", call_id: "call_c", name: "old_patch", input: "x" },
        { type: "custom_tool_call_output", call_id: "call_c", output: "ok" },
      ]));

      expect(req._customToolNames).toEqual(["old_patch"]);
    });
  });
});

describe("non-streaming reply status for a Codex request", () => {
  describe.each(ROUTES)("$label", (route) => {
    const finish = route.target === FORMATS.CLAUDE ? "max_tokens" : "length";

    it(`reports a reply cut off by ${finish} as incomplete`, () => {
      const req = translate(route, codexRequest({ stream: false }));
      const { out } = nonStreamCall(route, req, "exec_command", "{\"cmd\":\"ls\"}", finish);

      expect(out.status).toBe("incomplete");
      expect(out.incomplete_details).toEqual({ reason: "max_output_tokens" });
    });

    it("reports a finished tool call as completed", () => {
      const req = translate(route, codexRequest({ stream: false }));
      const { out } = nonStreamCall(route, req, "exec_command", "{\"cmd\":\"ls\"}");

      expect(out.status).toBe("completed");
      expect(out).not.toHaveProperty("incomplete_details");
    });
  });

  it("reports a filtered Chat reply as incomplete with content_filter", () => {
    const req = translate(ROUTES[0], codexRequest({ stream: false }));
    const { out } = nonStreamCall(ROUTES[0], req, "exec_command", "{}", "content_filter");

    expect(out).toMatchObject({ status: "incomplete", incomplete_details: { reason: "content_filter" } });
  });

  it("reports an unknown finish reason as completed", () => {
    const req = translate(ROUTES[0], codexRequest({ stream: false }));
    const { out } = nonStreamCall(ROUTES[0], req, "exec_command", "{}", "something_new");

    expect(out.status).toBe("completed");
  });

  it("replays an incomplete Responses body to a streaming client as response.incomplete", () => {
    const req = translate(ROUTES[0], codexRequest({ stream: false }));
    const { out } = nonStreamCall(ROUTES[0], req, "exec_command", "{}", "length");
    const events = jsonReplyToSse(out, FORMATS.OPENAI_RESPONSES).split("\n\n").filter(Boolean)
      .map((block) => block.split("\n").find((l) => l.startsWith("event: ")).slice(7));

    expect(events.at(-1)).toBe("response.incomplete");
    expect(events).not.toContain("response.completed");
    expect(jsonReplyToSse({ ...out, status: "completed" }, FORMATS.OPENAI_RESPONSES)).toContain("event: response.completed");
  });

  it("turns a Gemini reply into a Responses body with the client's tool name", () => {
    const req = translate({ target: FORMATS.GEMINI, provider: "gemini" }, codexRequest({ stream: false }));
    const { customToolNames, toolNamespaces } = takeToolMetadata(req);
    const out = translateNonStreamingResponse({
      candidates: [{
        content: { role: "model", parts: [{ functionCall: { name: "mcp__cua_repl__js", args: { code: "1" } } }] },
        finishReason: "STOP",
      }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
      modelVersion: MODEL,
    }, FORMATS.GEMINI, FORMATS.OPENAI_RESPONSES, customToolNames, toolNamespaces);

    expect(out).toMatchObject({ object: "response", status: "completed" });
    expect(out.output).toEqual([expect.objectContaining({
      type: "function_call", name: "js", namespace: "mcp__cua_repl", arguments: "{\"code\":\"1\"}",
    })]);
  });
});

describe("a forced tool_choice that names no declared tool", () => {
  const choiceFor = (choice, tools = codexTools()) =>
    openaiResponsesToOpenAIRequest(MODEL, { ...codexRequest(), tools, tool_choice: choice }, true, null).tool_choice;

  it.each([
    ["a bare name only declared qualified", { type: "function", name: "js" }],
    ["a hosted tool", { type: "function", name: "web_search" }],
    ["a namespace that doesn't have it", { type: "function", name: "js", namespace: "mcp__other" }],
    ["an unknown custom tool", { type: "custom", name: "old_patch" }],
  ])("falls back to auto for %s", (_label, choice) => {
    expect(choiceFor(choice)).toBe("auto");
  });

  it("falls back to auto for a deferred tool", () => {
    const tools = [fn("shell"), { ...fn("later"), defer_loading: true }];

    expect(choiceFor({ type: "function", name: "later" }, tools)).toBe("auto");
  });

  it("falls back to auto for a blank tool", () => {
    expect(choiceFor({ type: "function", name: " " }, [fn("shell"), fn(" ")])).toBe("auto");
  });

  it("still forces a declared tool", () => {
    expect(choiceFor({ type: "function", name: "js_add_node_module_dir", namespace: "mcp__node_repl" }))
      .toEqual({ type: "function", function: { name: "js_add_node_module_dir" } });
  });
});

describe("a forced tool with thinking on, for a Claude model", () => {
  const PROVIDER = "anthropic-compatible-acme";
  const claudeBody = (thinking, model = "claude-opus-5") => ({
    model, ...(thinking ? { thinking } : {}), tool_choice: { type: "tool", name: "shell", disable_parallel_tool_use: true },
  });

  it.each([
    ["enabled", { type: "enabled", budget_tokens: 2048 }],
    ["adaptive", { type: "adaptive" }],
  ])("becomes auto when thinking is %s", (_label, thinking) => {
    expect(relaxForcedToolChoiceForThinking(claudeBody(thinking), PROVIDER).tool_choice)
      .toEqual({ type: "auto", disable_parallel_tool_use: true });
  });

  it("becomes auto on a model that always thinks", () => {
    expect(relaxForcedToolChoiceForThinking(claudeBody(null, "claude-opus-5-5"), PROVIDER).tool_choice.type).toBe("auto");
  });

  it("stays forced when thinking is off", () => {
    expect(relaxForcedToolChoiceForThinking(claudeBody(null), PROVIDER).tool_choice.type).toBe("tool");
    expect(relaxForcedToolChoiceForThinking(claudeBody({ type: "disabled" }), PROVIDER).tool_choice.type).toBe("tool");
  });

  it("is applied to the body the executor sends", async () => {
    const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
    const sent = new DefaultExecutor(PROVIDER).finalizeBody(claudeBody({ type: "adaptive" }), {}, { apiKey: "key-a" });

    expect(sent.tool_choice.type).toBe("auto");
  });

  it("becomes auto on a Chat endpoint when a reasoning effort goes with it", () => {
    const chat = (extra) => ({ model: "claude-opus-5", tool_choice: { type: "function", function: { name: "shell" } }, ...extra });
    const provider = "openai-compatible-chat-acme";

    expect(relaxForcedChatToolChoiceForClaude(chat({ reasoning_effort: "high" }), provider, "claude-opus-5").tool_choice).toBe("auto");
    expect(relaxForcedChatToolChoiceForClaude(chat({}), provider, "claude-opus-5").tool_choice).toEqual({ type: "function", function: { name: "shell" } });
    expect(relaxForcedChatToolChoiceForClaude(chat({ reasoning_effort: "none" }), provider, "claude-opus-5").tool_choice.type).toBe("function");
    // Not a Claude model: left alone.
    expect(relaxForcedChatToolChoiceForClaude({ ...chat({ reasoning_effort: "high" }), model: "gpt-6-sol" }, provider, "gpt-6-sol").tool_choice.type).toBe("function");
  });
});
