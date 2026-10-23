// Claude Code on an openai-compatible node's Anthropic route must keep thinking.display.
import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...a) => fetchMock(...a) }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn(), logOpenAIRequest: vi.fn(),
  }),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}), saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

const SNOWFLAKE = "openai-compatible-chat-sf";
const BASE = "https://acme.snowflakecomputing.com/api/v2/cortex/v1";
const CLAUDE_CODE_UA = "claude-cli/2.1.309 (external, cli)";

const claudeReply = () => new Response(JSON.stringify({
  id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5",
  content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 },
}), { status: 200, headers: { "content-type": "application/json" } });

// Body shape captured from Claude Code 2.1.309 on the live route.
const claudeCodeBody = (model, thinking = { type: "adaptive", display: "summarized" }) => ({
  model,
  max_tokens: 32000,
  stream: false,
  system: [{ type: "text", text: "You are Claude Code." }],
  messages: [
    { role: "user", content: [{ type: "text", text: "Is 1001 prime?" }] },
    { role: "system", content: "<system-reminder>today is 2026-10-23</system-reminder>" },
  ],
  thinking,
  context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
  output_config: { effort: "medium" },
});

const snowflakeCreds = (model) => ({
  apiKey: "k",
  providerSpecificData: { apiType: "chat", baseUrl: BASE, modelRoutes: { [model]: "anthropic" }, stripBeta: true },
});

async function send(provider, model, body, credentials) {
  fetchMock.mockResolvedValueOnce(claudeReply());
  await handleChatCore({
    body, modelInfo: { provider, model }, credentials,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() }, connectionId: "c",
    clientRawRequest: { endpoint: "/v1/messages", body, headers: { "user-agent": CLAUDE_CODE_UA, accept: "application/json" } },
  });
  const [url, init] = fetchMock.mock.calls.at(-1);
  return { url, sent: JSON.parse(init.body) };
}

beforeEach(() => fetchMock.mockReset());

describe("Claude Code on an openai-compatible node's Messages route", () => {
  it.each(["claude-opus-5-5", "claude-sonnet-5-5"])("%s keeps thinking.display upstream", async (model) => {
    const { url, sent } = await send(SNOWFLAKE, model, claudeCodeBody(model), snowflakeCreds(model));
    expect(url).toBe(`${BASE}/messages`);
    expect(sent.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(sent.output_config).toEqual({ effort: "medium" });
  });

  // #112: the node strips every beta, so its gated body fields go too.
  it("still drops context_management when the node strips betas", async () => {
    const model = "claude-opus-5-5";
    const { sent } = await send(SNOWFLAKE, model, claudeCodeBody(model), snowflakeCreds(model));
    expect(sent).not.toHaveProperty("context_management");
  });

  // #115: budget thinking is rewritten to adaptive for models that reject budget_tokens.
  it("still rewrites budget thinking to adaptive on Sonnet 5.5", async () => {
    const model = "claude-sonnet-5-5";
    const body = claudeCodeBody(model, { type: "enabled", budget_tokens: 8000, display: "summarized" });
    delete body.output_config;
    const { sent } = await send(SNOWFLAKE, model, body, snowflakeCreds(model));
    expect(sent.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(sent.thinking).not.toHaveProperty("budget_tokens");
  });

  it("keeps the node's own thinking blocks in a tool loop", async () => {
    const model = "claude-opus-5-5";
    const body = claudeCodeBody(model);
    const thinking = { type: "thinking", thinking: "check the file", signature: "Cq8BsnowflakeSig" };
    body.messages = [
      { role: "user", content: [{ type: "text", text: "read a.txt" }] },
      { role: "assistant", content: [thinking, { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "a.txt" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "hi" }] },
      { role: "system", content: "<system-reminder>x</system-reminder>" },
    ];
    const { sent } = await send(SNOWFLAKE, model, body, snowflakeCreds(model));
    const assistant = sent.messages.find((m) => m.role === "assistant");
    expect(assistant.content[0]).toEqual(thinking);
    expect(sent.thinking).toEqual({ type: "adaptive", display: "summarized" });
  });
});
