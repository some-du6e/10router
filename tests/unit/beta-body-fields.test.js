// Body fields that only exist behind an anthropic-beta flag must go when the
// endpoint drops that flag. Live failure (2026-10-22, Snowflake Cortex node with
// stripBeta, claude-opus-5-5 routed to /messages):
//   400 {"message":"context_management: Extra inputs are not permitted"}
import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
const { resolveCompatibleRoute } = await import("../../open-sse/services/provider.js");
const { translateRequest } = await import("../../open-sse/translator/index.js");
const { stripBetaBodyFields } = await import("../../open-sse/utils/anthropicBeta.js");

const SNOWFLAKE = "openai-compatible-chat-eea96964-59c9-40ee-b64e-9e3bed15b7cb";
const MODEL = "claude-opus-5-5";
const CONTEXT_MANAGEMENT = { edits: [{ type: "clear_thinking_20251015", keep: "all" }] };
const BETA_400 = "{\"message\":\"Unexpected value(s) `context-management-2025-06-27` for the `anthropic-beta` header. Please consult our documentation at platform.claude.com/docs or try again without the header.\"}";

function res(status, text = "") {
  return { status, ok: status >= 200 && status < 300, headers: { get: () => "" }, clone: () => ({ text: async () => text }) };
}

// The Claude Code body shape captured from the failing live requests.
const claudeCodeBody = () => ({
  model: MODEL,
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  system: [{ type: "text", text: "You are Claude Code." }],
  max_tokens: 128000,
  stream: true,
  context_management: CONTEXT_MANAGEMENT,
  output_config: { effort: "medium" },
});

function snowflakeCreds(psd = {}) {
  const credentials = {
    apiKey: "k",
    providerSpecificData: {
      apiType: "chat",
      baseUrl: "https://acme.snowflakecomputing.com/api/v2/cortex/v1",
      modelRoutes: { [MODEL]: "anthropic" },
      ...psd,
    },
  };
  credentials.runtimeTransport = resolveCompatibleRoute(SNOWFLAKE, MODEL, credentials);
  return credentials;
}

const anthropicCompatCreds = (psd = {}) => ({
  apiKey: "k",
  providerSpecificData: { baseUrl: "https://gateway.example.com/v1", ...psd },
});

const sentBody = (i = 0) => JSON.parse(fetchMock.mock.calls[i][1].body);

beforeEach(() => fetchMock.mockReset());

describe("stripBetaBodyFields", () => {
  it("drops context_management when its beta is dropped", () => {
    const out = stripBetaBodyFields(claudeCodeBody(), { dropped: ["context-management-2025-06-27"] });
    expect(out).not.toHaveProperty("context_management");
    expect(out.output_config).toEqual({ effort: "medium" });
  });
  it("drops context_management when every beta is stripped", () => {
    expect(stripBetaBodyFields(claudeCodeBody(), { stripAll: true })).not.toHaveProperty("context_management");
  });
  it("keeps context_management when other betas are dropped", () => {
    const out = stripBetaBodyFields(claudeCodeBody(), { dropped: ["oauth-2025-04-20"] });
    expect(out.context_management).toEqual(CONTEXT_MANAGEMENT);
  });
});

describe("DefaultExecutor — beta-gated body fields on Messages paths", () => {
  it("drops context_management for the live Snowflake route (stripBeta, claude model → /messages)", async () => {
    fetchMock.mockResolvedValueOnce(res(200));
    const credentials = snowflakeCreds({ stripBeta: true });
    expect(credentials.runtimeTransport.format).toBe("claude");

    await new DefaultExecutor(SNOWFLAKE).execute({ model: MODEL, body: claudeCodeBody(), stream: true, credentials });

    expect(fetchMock.mock.calls[0][0]).toBe("https://acme.snowflakecomputing.com/api/v2/cortex/v1/messages");
    const body = sentBody();
    expect(body).not.toHaveProperty("context_management");
    expect(body.output_config).toEqual({ effort: "medium" });
    expect(body.system).toEqual([{ type: "text", text: "You are Claude Code." }]);
  });

  it("drops context_management on an anthropic-compatible node that learned to drop its beta", async () => {
    fetchMock.mockResolvedValueOnce(res(200));
    const credentials = anthropicCompatCreds({ droppedBetas: ["context-management-2025-06-27"] });
    await new DefaultExecutor("anthropic-compatible-test").execute({ model: MODEL, body: claudeCodeBody(), stream: true, credentials });
    expect(sentBody()).not.toHaveProperty("context_management");
  });

  it("drops context_management on the retry after the gateway rejects its beta", async () => {
    fetchMock.mockResolvedValueOnce(res(400, BETA_400)).mockResolvedValueOnce(res(200));
    const ex = new DefaultExecutor("anthropic-compatible-test");
    ex.config = { ...ex.config, headers: { "anthropic-beta": "context-management-2025-06-27" } };
    await ex.execute({ model: MODEL, body: claudeCodeBody(), stream: true, credentials: anthropicCompatCreds() });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentBody(0).context_management).toEqual(CONTEXT_MANAGEMENT);
    expect(sentBody(1)).not.toHaveProperty("context_management");
  });

  it("keeps context_management on an anthropic-compatible node that drops no betas", async () => {
    fetchMock.mockResolvedValueOnce(res(200));
    await new DefaultExecutor("anthropic-compatible-test").execute({ model: MODEL, body: claudeCodeBody(), stream: true, credentials: anthropicCompatCreds() });
    expect(sentBody().context_management).toEqual(CONTEXT_MANAGEMENT);
  });

  it("keeps context_management when only unrelated betas are dropped", async () => {
    fetchMock.mockResolvedValueOnce(res(200));
    const credentials = snowflakeCreds({ droppedBetas: ["oauth-2025-04-20", "redact-thinking-2026-02-12"] });
    await new DefaultExecutor(SNOWFLAKE).execute({ model: MODEL, body: claudeCodeBody(), stream: true, credentials });
    expect(sentBody().context_management).toEqual(CONTEXT_MANAGEMENT);
  });

  it("leaves the same node's Chat Completions route alone (stripBeta, non-claude model)", async () => {
    fetchMock.mockResolvedValueOnce(res(200));
    const model = "gpt-6";
    const credentials = { apiKey: "k", providerSpecificData: { ...snowflakeCreds().providerSpecificData, stripBeta: true } };
    credentials.runtimeTransport = resolveCompatibleRoute(SNOWFLAKE, model, credentials);
    const body = { model, messages: [{ role: "user", content: "hi" }], stream: true, context_management: CONTEXT_MANAGEMENT };

    await new DefaultExecutor(SNOWFLAKE).execute({ model, body, stream: true, credentials });

    expect(fetchMock.mock.calls[0][0]).toBe("https://acme.snowflakecomputing.com/api/v2/cortex/v1/chat/completions");
    expect(sentBody().context_management).toEqual(CONTEXT_MANAGEMENT);
  });

  it("does not mutate the caller's body", async () => {
    fetchMock.mockResolvedValueOnce(res(200));
    const body = claudeCodeBody();
    await new DefaultExecutor(SNOWFLAKE).execute({ model: MODEL, body, stream: true, credentials: snowflakeCreds({ stripBeta: true }) });
    expect(body.context_management).toEqual(CONTEXT_MANAGEMENT);
  });
});

describe("claude → openai translation", () => {
  it("never carries context_management to a Chat Completions body", () => {
    const out = translateRequest("claude", "openai", MODEL, claudeCodeBody(), true, null, SNOWFLAKE);
    expect(out).not.toHaveProperty("context_management");
  });
});
