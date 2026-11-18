// A Codex request with shared MCP tool names, run through chatCore and the real
// executor and stream pipeline to a Claude model on a custom endpoint. Only the
// network is faked: what goes upstream is the body the executor would send.
import { describe, expect, it, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...args) => fetchMock(...args) }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn(), logOpenAIRequest: vi.fn(),
  }),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

// Rejects a forced tool_choice whatever the thinking setting.
const MODEL = "claude-opus-5-5";
// Accepts a forced tool_choice, thinking or not.
const SWITCHABLE_MODEL = "claude-opus-5";
// Rejects a forced tool_choice only while thinking is on.
const CLAUDE_4_MODEL = "claude-sonnet-4-6";
const PATCH = "*** Begin Patch\n*** End Patch\n";
const schema = { type: "object", properties: {} };
const fn = (name) => ({ type: "function", name, description: name, parameters: schema });
const ns = (name, tools) => ({ type: "namespace", name, description: name, tools });

const TOOLS = [
  fn("exec_command"),
  { type: "custom", name: "apply_patch", description: "edit files", format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } },
  { type: "web_search", external_web_access: true },
  ns("mcp__cua_repl", [fn("js"), fn("js_reset")]),
  ns("mcp__node_repl", [fn("js"), fn("js_add_node_module_dir"), fn("js_reset")]),
];

const ROUTES = [
  { label: "Chat Completions endpoint", provider: "openai-compatible-chat-acme", upstream: "chat" },
  { label: "Anthropic-compatible endpoint", provider: "anthropic-compatible-acme", upstream: "claude" },
];

function sse(events) {
  const text = events.map((e) => (e.event ? `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n` : `data: ${e}\n\n`)).join("");
  return new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

// The upstream answers with one tool call to `wireName`.
function upstreamCall(route, wireName, args) {
  if (route.upstream === "chat") {
    const chunk = (delta, finish = null) => JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] });
    return sse([
      chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: wireName, arguments: "" } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: args } }] }),
      chunk({}, "tool_calls"),
      "[DONE]",
    ]);
  }
  return sse([
    { event: "message_start", data: { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: MODEL, content: [], usage: { input_tokens: 1, output_tokens: 0 } } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: wireName, input: {} } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: args } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);
}

async function runCodex(route, { tool_choice = "auto", input, stream = true, reasoning, overrides, model = MODEL } = {}) {
  const body = {
    model,
    stream,
    store: false,
    instructions: "You are Codex.",
    tools: TOOLS,
    tool_choice,
    ...(reasoning ? { reasoning } : {}),
    input: input || [{ type: "message", role: "user", content: [{ type: "input_text", text: "reset the node repl" }] }],
  };
  const result = await handleChatCore({
    body: structuredClone(body),
    modelInfo: { provider: route.provider, model },
    credentials: { apiKey: "key-a", providerSpecificData: { baseUrl: "https://acme.example/v1", ...(overrides ? { overrides } : {}) } },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    connectionId: "conn-a",
    clientRawRequest: {
      endpoint: "/v1/responses",
      body,
      headers: { accept: stream ? "text/event-stream" : "application/json", "user-agent": "codex_cli_rs/0.200.0" },
    },
  });
  return result;
}

// A non-streaming upstream reply: one tool call to `wireName`.
function upstreamJson(route, wireName, args, finish = null) {
  const body = route.upstream === "chat"
    ? {
      id: "chatcmpl-1", object: "chat.completion", model: MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: wireName, arguments: args } }] }, finish_reason: finish || "tool_calls" }],
      usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
    }
    : {
      id: "msg_1", type: "message", role: "assistant", model: MODEL,
      content: [{ type: "tool_use", id: "toolu_1", name: wireName, input: JSON.parse(args) }],
      stop_reason: finish || "tool_use", usage: { input_tokens: 1, output_tokens: 3 },
    };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

// Every SSE event the client got, in order.
async function clientEvents(result) {
  const text = await result.response.text();
  return text.split("\n\n")
    .map((block) => block.split("\n").find((line) => line.startsWith("data: ")))
    .filter((line) => line && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)));
}

const sentBody = () => JSON.parse(fetchMock.mock.calls[0][1].body);
const toolName = (tool) => tool.function?.name ?? tool.name;

async function clientItems(result) {
  return (await clientEvents(result)).filter((e) => e.type === "response.output_item.done").map((e) => e.item);
}

beforeEach(() => fetchMock.mockReset());

describe.each(ROUTES)("Codex through chatCore to a Claude model ($label)", (route) => {
  it("sends unique tool names upstream and hands the call back with the client's name and namespace", async () => {
    fetchMock.mockResolvedValueOnce(upstreamCall(route, "mcp__node_repl__js_reset", "{}"));
    const result = await runCodex(route);
    const names = sentBody().tools.map(toolName);

    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(["mcp__cua_repl__js", "mcp__node_repl__js", "mcp__node_repl__js_reset", "js_add_node_module_dir"]));
    expect(names).not.toContain("web_search");
    expect(sentBody()).not.toHaveProperty("_toolNamespaces");
    expect(sentBody()).not.toHaveProperty("_customToolNames");

    const items = await clientItems(result);
    expect(items).toEqual([expect.objectContaining({ type: "function_call", name: "js_reset", namespace: "mcp__node_repl", arguments: "{}" })]);
  });

  it("hands an apply_patch call back as a custom_tool_call with the raw patch", async () => {
    fetchMock.mockResolvedValueOnce(upstreamCall(route, "apply_patch", JSON.stringify({ input: PATCH })));
    const items = await clientItems(await runCodex(route));

    expect(items).toEqual([expect.objectContaining({ type: "custom_tool_call", name: "apply_patch", input: PATCH })]);
  });

  // The plain forcing tests use Opus 5, which accepts a forced tool.
  const forced = (name) => (route.upstream === "chat" ? { type: "function", function: { name } } : { type: "tool", name });
  const auto = route.upstream === "chat" ? "auto" : { type: "auto" };

  it("forces a qualified tool upstream when Codex forces it by name and namespace", async () => {
    fetchMock.mockResolvedValueOnce(upstreamCall(route, "mcp__cua_repl__js", "{}"));
    await runCodex(route, { model: SWITCHABLE_MODEL, tool_choice: { type: "function", name: "js", namespace: "mcp__cua_repl" } });

    expect(sentBody().tool_choice).toEqual(forced("mcp__cua_repl__js"));
  });

  it("forces a plain tool upstream when Codex forces it by name", async () => {
    fetchMock.mockResolvedValueOnce(upstreamCall(route, "exec_command", "{}"));
    await runCodex(route, { model: SWITCHABLE_MODEL, tool_choice: { type: "function", name: "exec_command" } });

    expect(sentBody().tool_choice).toEqual(forced("exec_command"));
    expect(sentBody().thinking).toBeUndefined();
    expect(sentBody().reasoning_effort).toBeUndefined();
  });

  it("forces apply_patch upstream when Codex forces the custom tool", async () => {
    fetchMock.mockResolvedValueOnce(upstreamCall(route, "apply_patch", JSON.stringify({ input: PATCH })));
    await runCodex(route, { model: SWITCHABLE_MODEL, tool_choice: { type: "custom", name: "apply_patch" } });

    expect(sentBody().tool_choice).toEqual(forced("apply_patch"));
  });

  it("keeps the forced tool on Opus 5 when Codex sends a reasoning effort", async () => {
    fetchMock.mockResolvedValueOnce(upstreamCall(route, "mcp__cua_repl__js", "{}"));
    await runCodex(route, { model: SWITCHABLE_MODEL, tool_choice: { type: "function", name: "js", namespace: "mcp__cua_repl" }, reasoning: { effort: "high" } });
    const sent = sentBody();

    if (route.upstream === "chat") expect(sent.reasoning_effort).toBe("high");
    else expect(sent.thinking?.type).toBe("adaptive");
    expect(sent.tool_choice).toEqual(forced("mcp__cua_repl__js"));
  });

  it("lets a Claude 4.x model choose when Codex forces a tool and sends a reasoning effort", async () => {
    fetchMock.mockResolvedValueOnce(upstreamCall(route, "exec_command", "{}"));
    await runCodex(route, { model: CLAUDE_4_MODEL, tool_choice: { type: "function", name: "exec_command" }, reasoning: { effort: "high" } });
    const sent = sentBody();

    if (route.upstream === "chat") expect(sent.reasoning_effort).toBe("high");
    else expect(sent.thinking?.type).toBe("adaptive");
    expect(sent.tool_choice).toEqual(auto);
  });

  it("keeps the forced tool on a Claude 4.x model without a reasoning effort", async () => {
    fetchMock.mockResolvedValueOnce(upstreamCall(route, "exec_command", "{}"));
    await runCodex(route, { model: CLAUDE_4_MODEL, tool_choice: { type: "function", name: "exec_command" } });

    expect(sentBody().tool_choice).toEqual(forced("exec_command"));
  });

  it("lets Opus 5.5 choose when Codex forces a tool, since it rejects forced tools", async () => {
    fetchMock.mockResolvedValueOnce(upstreamCall(route, "apply_patch", JSON.stringify({ input: PATCH })));
    await runCodex(route, { model: MODEL, tool_choice: { type: "custom", name: "apply_patch" } });

    expect(sentBody().tool_choice).toEqual(auto);
  });

  it("returns a non-streaming upstream JSON reply with the client's name and namespace", async () => {
    fetchMock.mockResolvedValueOnce(upstreamJson(route, "mcp__cua_repl__js", "{\"code\":\"1\"}"));
    const json = await (await runCodex(route, { stream: false })).response.json();

    expect(json.object).toBe("response");
    expect(json.output).toEqual([expect.objectContaining({ type: "function_call", name: "js", namespace: "mcp__cua_repl", arguments: "{\"code\":\"1\"}" })]);
  });

  it("returns a non-streaming apply_patch reply as a custom_tool_call", async () => {
    fetchMock.mockResolvedValueOnce(upstreamJson(route, "apply_patch", JSON.stringify({ input: PATCH })));
    const json = await (await runCodex(route, { stream: false })).response.json();

    expect(json.output).toEqual([expect.objectContaining({ type: "custom_tool_call", name: "apply_patch", input: PATCH })]);
  });

  it("replays a JSON reply to a streaming request with the client's name and namespace", async () => {
    fetchMock.mockResolvedValueOnce(upstreamJson(route, "mcp__node_repl__js", "{}"));
    const items = await clientItems(await runCodex(route));

    expect(items).toEqual([expect.objectContaining({ type: "function_call", name: "js", namespace: "mcp__node_repl" })]);
  });

  it("replays a JSON reply cut off at the token limit as response.incomplete", async () => {
    fetchMock.mockResolvedValueOnce(upstreamJson(route, "exec_command", "{}", route.upstream === "chat" ? "length" : "max_tokens"));
    const events = await clientEvents(await runCodex(route));
    const last = events[events.length - 1];

    expect(last.type).toBe("response.incomplete");
    expect(last.response).toMatchObject({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } });
    expect(events.some((e) => e.type === "response.completed")).toBe(false);
  });
});

describe("Codex through chatCore with a forced-streaming Chat endpoint", () => {
  const route = ROUTES[0];

  it("folds the upstream stream into JSON with the client's name and namespace", async () => {
    fetchMock.mockResolvedValueOnce(upstreamCall(route, "mcp__cua_repl__js_reset", "{}"));
    const result = await runCodex(route, { stream: false, overrides: { stream: "always" } });
    const json = await result.response.json();

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).stream).toBe(true);
    expect(json.output).toEqual([expect.objectContaining({ type: "function_call", name: "js_reset", namespace: "mcp__cua_repl" })]);
  });

  it("folds an apply_patch call into a custom_tool_call", async () => {
    fetchMock.mockResolvedValueOnce(upstreamCall(route, "apply_patch", JSON.stringify({ input: PATCH })));
    const json = await (await runCodex(route, { stream: false, overrides: { stream: "always" } })).response.json();

    expect(json.output).toEqual([expect.objectContaining({ type: "custom_tool_call", name: "apply_patch", input: PATCH })]);
  });
});

// Executors that build and send a Claude body themselves, skipping finalizeBody.
describe("a forced tool on Claude routes that skip finalizeBody", () => {
  const chatBody = (model, extra = {}) => ({
    model, stream: true, reasoning_effort: "high",
    messages: [{ role: "user", content: "run it" }],
    tools: [{ type: "function", function: { name: "exec_command", parameters: { type: "object", properties: {} } } }],
    tool_choice: { type: "function", function: { name: "exec_command" } },
    ...extra,
  });

  it("github's Messages route sends auto for Sonnet 4.6 with thinking, and for Opus 5.5", async () => {
    const { GithubExecutor } = await import("../../open-sse/executors/github.js");
    const executor = new GithubExecutor();
    fetchMock.mockResolvedValue(new Response("{}", { status: 400 }));

    await executor.executeWithMessagesEndpoint({ model: "claude-sonnet-4-6", body: chatBody("claude-sonnet-4-6"), stream: true, credentials: { accessToken: "key-a" } });
    const sonnet = JSON.parse(fetchMock.mock.calls[0][1].body);
    await executor.executeWithMessagesEndpoint({ model: "claude-opus-5-5", body: chatBody("claude-opus-5-5", { reasoning_effort: undefined }), stream: true, credentials: { accessToken: "key-a" } });
    const opus = JSON.parse(fetchMock.mock.calls[1][1].body);

    expect(sonnet.thinking?.type).toBe("adaptive");
    expect(sonnet.tool_choice).toEqual({ type: "auto" });
    expect(opus.tool_choice).toEqual({ type: "auto" });
  });

  it("zed's Anthropic request sends auto for Opus 5.5 and keeps the forced tool on Opus 5", async () => {
    const { buildProviderRequest } = await import("../../open-sse/executors/zed.js");

    expect(buildProviderRequest("Anthropic", "claude-opus-5-5", chatBody("claude-opus-5-5"), true, {}).tool_choice).toEqual({ type: "auto" });
    expect(buildProviderRequest("Anthropic", "claude-opus-5", chatBody("claude-opus-5"), true, {}).tool_choice).toEqual({ type: "tool", name: "exec_command" });
  });
});
