// Claude Code 2.1.32x adds tools mid-conversation with a role "system" message
// in messages[] carrying tool_addition / tool_removal blocks, behind
// mid-conversation-tool-changes-2026-07-01 (by reference) and
// inline-tools-2026-09-15 (by value or by reference). A strict
// Anthropic-compatible endpoint without those betas 400s on the block type
// ("messages.N.content.1: Input tag 'tool_addition' ... does not match any of
// the expected tags"), every key fails the same way, and the conversation dies.
import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
const saveRequestDetail = vi.fn(async () => {});
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...a) => fetchMock(...a) }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn(), logOpenAIRequest: vi.fn(),
  }),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}), saveRequestDetail: (...a) => saveRequestDetail(...a), saveRequestUsage: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
const { resolveCompatibleRoute } = await import("../../open-sse/services/provider.js");
const { inlineToolChangesWithoutBeta, sentBetas } = await import("../../open-sse/utils/anthropicBeta.js");

const MODEL = "claude-opus-5-5";
const MID_BETA = "mid-conversation-tool-changes-2026-07-01";
const INLINE_BETA = "inline-tools-2026-09-15";
const CLIENT_BETAS = `${MID_BETA},${INLINE_BETA},effort-2025-11-24`;
const GATEWAY = "https://gateway.example.com/v1";
const TWO_PATH = "openai-compatible-chat-gw";

const schema = { type: "object", properties: { q: { type: "string" } } };
const TOOLS = [
  { name: "Read", description: "Read a file", input_schema: schema },
  { name: "mcp__docs__search", description: "Search the docs", input_schema: schema, defer_loading: true },
  { name: "mcp__docs__fetch", description: "Fetch a doc page", input_schema: schema, defer_loading: true },
];
const NEW_TOOL = { name: "mcp__notes__add", description: "Add a note", input_schema: schema };

const addRef = (name) => ({ type: "tool_addition", tool: { type: "tool_reference", name } });
const addDef = (definition) => ({ type: "tool_addition", tool: { type: "tool_definition", definition } });
const removeRef = (name) => ({ type: "tool_removal", tool: { type: "tool_reference", name } });
const text = (t) => ({ type: "text", text: t });
const user = (...content) => ({ role: "user", content });
const assistant = (...content) => ({ role: "assistant", content });
const system = (...content) => ({ role: "system", content });

const claudeCodeBody = (messages, extra = {}) => ({
  model: MODEL,
  max_tokens: 4096,
  system: [text("You are Claude Code.")],
  tools: structuredClone(TOOLS),
  messages,
  stream: false,
  ...extra,
});

// One by-reference addition between two user turns (how Claude Code surfaces a deferred MCP tool).
const byReference = () => claudeCodeBody([
  user(text("look this up in the docs")),
  system(addRef("mcp__docs__search")),
  user(text("go ahead")),
]);

const toolNamed = (body, name) => body.tools.find((t) => t.name === name);
const noToolChanges = (body) => expect(JSON.stringify(body)).not.toMatch(/tool_addition|tool_removal/);

function res(status, body = "") {
  return { status, ok: status >= 200 && status < 300, headers: { get: () => "" }, clone: () => ({ text: async () => body }) };
}
const sent = (i = 0) => fetchMock.mock.calls[i][1];
const sentBody = (i = 0) => JSON.parse(sent(i).body);
const sentFlags = (i = 0) => [...sentBetas(sent(i).headers)];

function twoPathCreds(psd = {}) {
  const credentials = { apiKey: "k", providerSpecificData: { apiType: "chat", baseUrl: GATEWAY, modelRoutes: { [MODEL]: "anthropic" }, ...psd } };
  credentials.runtimeTransport = resolveCompatibleRoute(TWO_PATH, MODEL, credentials);
  return credentials;
}
const compatCreds = (baseUrl, extra = {}) => ({ apiKey: "k", providerSpecificData: { baseUrl, ...extra }, rawHeaders: { "anthropic-beta": CLIENT_BETAS } });
const run = (provider, credentials, body, model = MODEL) =>
  new DefaultExecutor(provider).execute({ model, body, stream: false, credentials });

beforeEach(() => {
  fetchMock.mockReset();
  saveRequestDetail.mockClear();
});

describe("tool changes folded into tools[] without their beta", () => {
  const fold = (body, headers = {}) => inlineToolChangesWithoutBeta(body, headers);

  it("by reference: un-defers that tool only, drops the block and the empty system message", () => {
    const body = byReference();
    const out = fold(body);

    expect(toolNamed(out, "mcp__docs__search")).toEqual({ name: "mcp__docs__search", description: "Search the docs", input_schema: schema });
    expect(toolNamed(out, "mcp__docs__fetch").defer_loading).toBe(true);
    expect(out.tools).toHaveLength(3);
    // The two user turns the system message sat between become one.
    expect(out.messages).toEqual([user(text("look this up in the docs"), text("go ahead"))]);
    noToolChanges(out);
    // The caller's body is reused for account fallback, so it is left as it was.
    expect(body).toEqual(byReference());
  });

  it("by value: appends a new tool", () => {
    const out = fold(claudeCodeBody([user(text("take a note")), system(addDef(NEW_TOOL))]));
    expect(out.tools.map((t) => t.name)).toEqual(["Read", "mcp__docs__search", "mcp__docs__fetch", "mcp__notes__add"]);
    expect(toolNamed(out, "mcp__notes__add")).toEqual(NEW_TOOL);
    expect(out.messages).toEqual([user(text("take a note"))]);
  });

  it("by value: replaces a declared tool of the same name with the inline definition", () => {
    const newer = { name: "mcp__docs__fetch", description: "Fetch a doc page (v2)", input_schema: schema };
    const out = fold(claudeCodeBody([user(text("fetch it")), system(addDef(newer))]));
    expect(out.tools).toHaveLength(3);
    expect(toolNamed(out, "mcp__docs__fetch")).toEqual(newer);
  });

  it("adds tools[] when the body had none", () => {
    const body = claudeCodeBody([user(text("take a note")), system(addDef(NEW_TOOL))]);
    delete body.tools;
    expect(fold(body).tools).toEqual([NEW_TOOL]);
  });

  it("removal: drops the block and keeps the tool declared", () => {
    const out = fold(claudeCodeBody([
      user(text("read a.txt")),
      assistant({ type: "tool_use", id: "toolu_1", name: "Read", input: { q: "a.txt" } }),
      user({ type: "tool_result", tool_use_id: "toolu_1", content: "hello" }),
      system(removeRef("Read")),
    ]));
    expect(toolNamed(out, "Read")).toEqual(TOOLS[0]);
    expect(out.messages).toHaveLength(3);
    expect(out.messages.at(-1).role).toBe("user");
    noToolChanges(out);
  });

  it("a dropped trailing system message after an assistant turn doesn't leave a prefill", () => {
    const out = fold(claudeCodeBody([user(text("hi")), assistant(text("hello")), system(removeRef("Read"))]));
    expect(out.messages).toEqual([user(text("hi")), assistant(text("hello")), user(text("Continue."))]);
  });

  it("mixed content: the system message keeps its text", () => {
    const reminder = text("<system-reminder>The docs tool is now available.</system-reminder>");
    const out = fold(claudeCodeBody([user(text("look it up")), system(reminder, addRef("mcp__docs__search"))]));
    expect(out.messages).toEqual([user(text("look it up")), system(reminder)]);
    expect(toolNamed(out, "mcp__docs__search")).not.toHaveProperty("defer_loading");
  });

  it("a reference to a tool that isn't declared is just dropped", () => {
    const out = fold(claudeCodeBody([user(text("hi")), system(addRef("mcp__missing__tool")), user(text("go"))]));
    expect(out.tools).toEqual(TOOLS);
    noToolChanges(out);
  });

  it("headers = null (unknown, the error log) folds every block", () => {
    noToolChanges(inlineToolChangesWithoutBeta(byReference(), null));
  });

  it("leaves a body without tool changes as the same object", () => {
    const body = claudeCodeBody([user(text("hi")), system(text("reminder")), user(text("go"))]);
    expect(fold(body)).toBe(body);
  });

  it.each([
    ["mid-conversation-tool-changes", MID_BETA],
    ["inline-tools", INLINE_BETA],
    ["mid-conversation-tool-changes among other flags", `effort-2025-11-24, ${MID_BETA}`],
  ])("passes a by-reference addition through untouched with %s (capitalised header)", (_label, flags) => {
    const body = byReference();
    expect(fold(body, { "Anthropic-Beta": flags })).toBe(body);
  });

  it("a dangling tool_use left last gets an interrupted tool_result, not \"Continue.\"", () => {
    const toolUse = { type: "tool_use", id: "toolu_9", name: "Read", input: { q: "b.txt" } };
    const out = fold(claudeCodeBody([user(text("read b.txt")), assistant(text("Reading."), toolUse), system(addRef("mcp__docs__search"))]));
    expect(out.messages.at(-1)).toEqual(user({
      type: "tool_result", tool_use_id: "toolu_9", content: "Tool execution was interrupted before a result was returned.", is_error: true,
    }));
  });

  it("leaves the client's own prefill alone when the dropped message isn't last", () => {
    const out = fold(claudeCodeBody([user(text("hi")), system(addRef("mcp__docs__search")), user(text("answer in JSON")), assistant(text("{"))]));
    expect(out.messages).toEqual([user(text("hi"), text("answer in JSON")), assistant(text("{"))]);
  });

  it("only merges the turns a dropped message sat between", () => {
    const out = fold(claudeCodeBody([user(text("a")), system(addRef("mcp__docs__search")), user(text("b")), user(text("c"))]));
    expect(out.messages).toEqual([user(text("a"), text("b")), user(text("c"))]);

    const kept = fold(claudeCodeBody([user(text("a")), user(text("b")), system(addRef("mcp__docs__search")), assistant(text("ok"))]));
    expect(kept.messages).toEqual([user(text("a")), user(text("b")), assistant(text("ok"))]);
  });

  it("merges string content as text blocks", () => {
    const out = fold(claudeCodeBody([{ role: "user", content: "a" }, system(addRef("mcp__docs__search")), { role: "user", content: "b" }]));
    expect(out.messages).toEqual([user(text("a"), text("b"))]);
  });

  it("a mixed message is copied, so a later attempt with the beta still has the block", () => {
    const body = claudeCodeBody([user(text("hi")), system(text("reminder"), addRef("mcp__docs__search"))]);
    fold(body);
    expect(body.messages[1].content).toEqual([text("reminder"), addRef("mcp__docs__search")]);
    expect(toolNamed(body, "mcp__docs__search").defer_loading).toBe(true);
  });

  it("doesn't add tools[] for a removal when the body had none", () => {
    const body = claudeCodeBody([user(text("hi")), system(removeRef("Read")), user(text("go"))]);
    delete body.tools;
    expect(fold(body)).not.toHaveProperty("tools");
  });

  it("an unknown tool.type goes through with either beta, and is dropped without one", () => {
    const odd = { type: "tool_addition", tool: { type: "tool_future_form", name: "mcp__docs__search" } };
    const body = claudeCodeBody([user(text("hi")), system(odd), user(text("go"))]);
    expect(fold(body, { "anthropic-beta": MID_BETA })).toBe(body);
    expect(fold(body, { "anthropic-beta": INLINE_BETA })).toBe(body);
    const out = fold(body);
    noToolChanges(out);
    expect(out.tools).toEqual(TOOLS);
  });

  it.each([
    ["an array", [NEW_TOOL]],
    ["one without a name", { description: "nameless", input_schema: schema }],
    ["a string", "mcp__notes__add"],
  ])("drops a malformed definition (%s) instead of adding it", (_label, definition) => {
    const out = fold(claudeCodeBody([user(text("hi")), system(addDef(definition))]));
    expect(out.tools).toEqual(TOOLS);
    noToolChanges(out);
  });

  it("moves a breakpoint on a removed block to the message now last", () => {
    const out = fold(claudeCodeBody([user(text("summary")), system({ ...addRef("mcp__docs__search"), cache_control: { type: "ephemeral" } })]));
    expect(out.messages).toEqual([user({ ...text("summary"), cache_control: { type: "ephemeral" } })]);
  });

  it("doesn't add a second breakpoint to a message that has one", () => {
    const marked = { ...text("summary"), cache_control: { type: "ephemeral", ttl: "1h" } };
    const out = fold(claudeCodeBody([user(text("a"), marked), system({ ...addRef("mcp__docs__search"), cache_control: { type: "ephemeral" } })]));
    expect(out.messages).toEqual([user(text("a"), marked)]);
  });

  it("an inline definition replacing a declared tool keeps that tool's breakpoint and brings none of its own", () => {
    const body = claudeCodeBody([user(text("hi")), system(addDef({ ...NEW_TOOL, cache_control: { type: "ephemeral" } }), addDef({ ...TOOLS[0], description: "v2" }))]);
    body.tools[0] = { ...body.tools[0], cache_control: { type: "ephemeral", ttl: "1h" } };
    const out = fold(body);
    expect(toolNamed(out, "Read")).toEqual({ ...TOOLS[0], description: "v2", cache_control: { type: "ephemeral", ttl: "1h" } });
    expect(toolNamed(out, "mcp__notes__add")).toEqual(NEW_TOOL);
  });

  it("a by-value addition needs inline-tools; the by-reference one beside it goes through", () => {
    const body = claudeCodeBody([user(text("hi")), system(addRef("mcp__docs__search"), addDef(NEW_TOOL))]);
    expect(fold(body, { "anthropic-beta": INLINE_BETA })).toBe(body);

    const out = fold(body, { "anthropic-beta": MID_BETA });
    expect(out.messages.at(-1)).toEqual(system(addRef("mcp__docs__search")));
    expect(toolNamed(out, "mcp__notes__add")).toEqual(NEW_TOOL);
    expect(toolNamed(out, "mcp__docs__search").defer_loading).toBe(true);
  });
});

describe("executor: a strict Anthropic-compatible endpoint", () => {
  // The live failure: a two-path custom endpoint routing a claude model to its Messages path.
  it("gets neither beta and no tool change blocks on a two-path node's Messages route", async () => {
    fetchMock.mockResolvedValueOnce(res(200));
    const body = claudeCodeBody([
      user(text("look it up")),
      system(text("<system-reminder>tools changed</system-reminder>"), addRef("mcp__docs__search")),
    ]);
    await run(TWO_PATH, { ...twoPathCreds(), rawHeaders: { "anthropic-beta": CLIENT_BETAS } }, body);

    expect(fetchMock.mock.calls[0][0]).toBe(`${GATEWAY}/messages`);
    const out = sentBody();
    noToolChanges(out);
    expect(out.messages.at(-1)).toEqual(system(text("<system-reminder>tools changed</system-reminder>")));
    expect(toolNamed(out, "mcp__docs__search")).not.toHaveProperty("defer_loading");
    expect(toolNamed(out, "mcp__docs__fetch").defer_loading).toBe(true);
    expect(sentFlags()).not.toContain(MID_BETA);
    expect(sentFlags()).not.toContain(INLINE_BETA);
    expect(sentFlags()).toContain("effort-2025-11-24");
  });

  it("is the same on an anthropic-compatible node at a third-party host", async () => {
    fetchMock.mockResolvedValueOnce(res(200));
    await run("anthropic-compatible-gw", compatCreds(GATEWAY), byReference());
    noToolChanges(sentBody());
    expect(sentFlags()).toEqual(["effort-2025-11-24"]);
  });

  it("is the same when the beta comes from the provider's own fixed headers", async () => {
    fetchMock.mockResolvedValueOnce(res(200));
    const ex = new DefaultExecutor("anthropic-compatible-gw");
    ex.config = { ...ex.config, headers: { ...ex.config.headers, "anthropic-beta": `${MID_BETA},effort-2025-11-24` } };
    await ex.execute({ model: MODEL, body: byReference(), stream: false, credentials: { apiKey: "k", providerSpecificData: { baseUrl: GATEWAY } } });
    noToolChanges(sentBody());
    expect(sentFlags()).not.toContain(MID_BETA);
    expect(sentFlags()).toContain("effort-2025-11-24");
  });

  it("an endpoint header line adding the beta back sends the blocks as they are", async () => {
    fetchMock.mockResolvedValueOnce(res(200));
    const body = byReference();
    await run("anthropic-compatible-gw", compatCreds(GATEWAY, { overrides: { headers: `anthropic-beta: ${MID_BETA}` } }), body);
    expect(sentFlags()).toContain(MID_BETA);
    expect(sentBody().messages).toEqual(body.messages);
    expect(sentBody().tools).toEqual(TOOLS);
  });
});

describe("executor: Anthropic's own API", () => {
  it("forwards the betas and the body unchanged", async () => {
    fetchMock.mockResolvedValueOnce(res(200));
    const body = claudeCodeBody([user(text("hi")), system(addRef("mcp__docs__search"), addDef(NEW_TOOL)), user(text("go"))]);
    await run("anthropic-compatible-official", compatCreds("https://api.anthropic.com/v1"), body);
    expect(sentBody()).toEqual(body);
    expect(sentFlags()).toEqual(expect.arrayContaining([MID_BETA, INLINE_BETA]));
  });

  it("folds them when the endpoint is set to send no beta header", async () => {
    fetchMock.mockResolvedValueOnce(res(200));
    await run("anthropic-compatible-official", compatCreds("https://api.anthropic.com/v1", { stripBeta: true }), byReference());
    noToolChanges(sentBody());
    expect(sentFlags()).toEqual([]);
  });
});

const ccHeaders = { "user-agent": "claude-cli/2.1.321 (external, cli)", accept: "application/json", "anthropic-beta": CLIENT_BETAS };
const claudeReply = () => new Response(JSON.stringify({
  id: "msg_1", type: "message", role: "assistant", model: MODEL,
  content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 },
}), { status: 200, headers: { "content-type": "application/json" } });
const chat = (body, { provider, psd }) => handleChatCore({
  body, modelInfo: { provider, model: MODEL },
  credentials: { apiKey: "k", providerSpecificData: psd },
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() }, connectionId: "c",
  clientRawRequest: { endpoint: "/v1/messages", body, headers: ccHeaders },
});
const twoPath = { provider: TWO_PATH, psd: { apiType: "chat", baseUrl: GATEWAY, modelRoutes: { [MODEL]: "anthropic" } } };

describe("Claude Code through chatCore", () => {
  it("two-path node (claude→claude): a system message holding only the addition still surfaces the tool", async () => {
    fetchMock.mockResolvedValueOnce(claudeReply());
    const result = await chat(byReference(), twoPath);

    expect(result.success).toBe(true);
    const out = sentBody();
    noToolChanges(out);
    expect(toolNamed(out, "mcp__docs__search")).not.toHaveProperty("defer_loading");
    expect(out.messages.filter((m) => m.role === "system")).toEqual([]);
  });

  it("two-path node: text beside the addition is kept, the block is not sent", async () => {
    fetchMock.mockResolvedValueOnce(claudeReply());
    const reminder = text("<system-reminder>tools changed</system-reminder>");
    await chat(claudeCodeBody([user(text("look it up")), system(reminder, addRef("mcp__docs__search"))]), twoPath);

    const out = sentBody();
    noToolChanges(out);
    expect(JSON.stringify(out.messages)).toContain("tools changed");
    expect(toolNamed(out, "mcp__docs__search")).not.toHaveProperty("defer_loading");
  });

  it("anthropic-compatible node at a third-party host (passthrough): the tool is surfaced, not lost", async () => {
    fetchMock.mockResolvedValueOnce(claudeReply());
    await chat(byReference(), { provider: "anthropic-compatible-gw", psd: { baseUrl: GATEWAY } });

    const out = sentBody();
    noToolChanges(out);
    expect(toolNamed(out, "mcp__docs__search")).not.toHaveProperty("defer_loading");
    expect(sentFlags()).not.toContain(MID_BETA);
  });

  it("Anthropic's own API (passthrough): the addition goes out with its beta", async () => {
    fetchMock.mockResolvedValueOnce(claudeReply());
    await chat(byReference(), { provider: "anthropic-compatible-official", psd: { baseUrl: "https://api.anthropic.com/v1" } });

    const out = sentBody();
    expect(out.messages).toContainEqual(system(addRef("mcp__docs__search")));
    expect(toolNamed(out, "mcp__docs__search").defer_loading).toBe(true);
    expect(out.tools).toHaveLength(3);
    expect(sentFlags()).toContain(MID_BETA);
  });

  it("claude→openai: a tool added by value reaches the OpenAI tools list, the blocks don't", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      id: "c1", object: "chat.completion", model: "chat-model-1",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const body = claudeCodeBody([user(text("note it")), system(text("reminder"), addDef(NEW_TOOL), removeRef("Read"))], { model: "chat-model-1" });
    const result = await handleChatCore({
      body, modelInfo: { provider: "openai-compatible-chat-gw", model: "chat-model-1" },
      credentials: { apiKey: "k", providerSpecificData: { apiType: "chat", baseUrl: GATEWAY } },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() }, connectionId: "c",
      clientRawRequest: { endpoint: "/v1/messages", body, headers: ccHeaders },
    });

    expect(result.success).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe(`${GATEWAY}/chat/completions`);
    const out = sentBody();
    noToolChanges(out);
    expect(out.tools.map((t) => t.function.name)).toContain("mcp__notes__add");
    expect(JSON.stringify(out.messages)).toContain("reminder");
  });

  it("logs the folded body when the upstream call throws", async () => {
    fetchMock.mockRejectedValueOnce(Object.freeze(Object.assign(new Error("aborted"), { name: "AbortError" })));
    await chat(byReference(), twoPath);

    expect(saveRequestDetail).toHaveBeenCalledTimes(1);
    const { providerRequest } = saveRequestDetail.mock.calls[0][0];
    noToolChanges(providerRequest);
    expect(toolNamed(providerRequest, "mcp__docs__search")).not.toHaveProperty("defer_loading");
  });

  // Strict gateways 400 on a tools[] entry without `type`; Claude Code's by-value definitions have none.
  it("two-path node: a tool added by value goes out shaped like the other tools", async () => {
    fetchMock.mockResolvedValueOnce(claudeReply());
    const fnShape = { type: "function", function: { name: "mcp__notes__list", description: "List notes", parameters: schema } };
    const builtIn = { type: "web_search_20250305", name: "web_search" };
    await chat(claudeCodeBody([user(text("note it")), system(addDef(NEW_TOOL), addDef(fnShape), addDef(builtIn))]), twoPath);

    const out = sentBody();
    noToolChanges(out);
    expect(toolNamed(out, "mcp__notes__add")).toEqual({ ...NEW_TOOL, type: "custom" });
    expect(toolNamed(out, "mcp__notes__list")).toEqual({ name: "mcp__notes__list", description: "List notes", input_schema: schema, type: "custom" });
    expect(toolNamed(out, "web_search")).toBeUndefined();
    expect(out.tools.every((t) => t.type)).toBe(true);
  });

  it("passthrough at a third-party host: a tool added by value gets type custom too", async () => {
    fetchMock.mockResolvedValueOnce(claudeReply());
    await chat(claudeCodeBody([user(text("note it")), system(addDef(NEW_TOOL))]), { provider: "anthropic-compatible-gw", psd: { baseUrl: GATEWAY } });
    expect(toolNamed(sentBody(), "mcp__notes__add")).toEqual({ ...NEW_TOOL, type: "custom" });
  });

  // After /compact: the summary, then the addition, and no assistant turn yet.
  it("passthrough at a third-party host: the opening prompt keeps its cache breakpoint", async () => {
    fetchMock.mockResolvedValueOnce(claudeReply());
    await chat(claudeCodeBody([user(text("summary of the conversation so far")), system(addRef("mcp__docs__search"))]), { provider: "anthropic-compatible-gw", psd: { baseUrl: GATEWAY } });

    const out = sentBody();
    noToolChanges(out);
    expect(out.messages).toEqual([user({ ...text("summary of the conversation so far"), cache_control: { type: "ephemeral" } })]);
  });

  it("Anthropic's own API (passthrough): text beside the addition is folded, the addition goes out", async () => {
    fetchMock.mockResolvedValueOnce(claudeReply());
    await chat(claudeCodeBody([user(text("look it up")), system(text("tools changed"), addRef("mcp__docs__search"))]), {
      provider: "anthropic-compatible-official", psd: { baseUrl: "https://api.anthropic.com/v1" },
    });

    const out = sentBody();
    expect(out.messages.at(-1)).toEqual(system(addRef("mcp__docs__search")));
    expect(JSON.stringify(out.messages[0])).toContain("tools changed");
  });
});

describe("translateRequest", () => {
  it("claude→claude keeps the blocks for the executor to decide on", async () => {
    const { translateRequest } = await import("../../open-sse/translator/index.js");
    const out = translateRequest("claude", "claude", MODEL, byReference(), false, { apiKey: "k" }, "anthropic-compatible-official");
    expect(out.messages).toContainEqual(system(addRef("mcp__docs__search")));
  });
});
