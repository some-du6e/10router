// Claude Code 2.1.312 in auto mode adds a top-level `safeguards` field (its
// server-side classifier input, behind dangerous-tool-use-2026-09-03). Live
// failure (2026-10-29, Snowflake Cortex node, claude-opus-5-5 routed to /messages):
//   400 {"message":"safeguards: Extra inputs are not permitted"}
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
const { stripBetaBodyFields, stripUngatedBodyFields, isAnthropicApiUrl } = await import("../../open-sse/utils/anthropicBeta.js");

const SNOWFLAKE = "openai-compatible-chat-eea96964-59c9-40ee-b64e-9e3bed15b7cb";
const BASE = "https://acme.snowflakecomputing.com/api/v2/cortex/v1";
const MODEL = "claude-opus-5-5";
const DANGEROUS_BETA = "dangerous-tool-use-2026-09-03";
const CLIENT_BETAS = `${DANGEROUS_BETA},effort-2025-11-24`;
const SAFEGUARDS = [{ type: "dangerous_tool_use", classifier_context: { v: 1, permission_mode: "auto" } }];
const RELAYS = ["https://api.anthropic.com.example.net/v1", "https://relay.example.net/api.anthropic.com/v1"];

function res(status, text = "") {
  return { status, ok: status >= 200 && status < 300, headers: { get: () => "" }, clone: () => ({ text: async () => text }) };
}

// Shape recorded from Claude Code 2.1.312 (`-p --permission-mode auto`) against a local mock.
const claudeCodeBody = (extra = {}) => ({
  model: MODEL,
  messages: [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "user", content: [{ type: "text", text: "say ok" }] },
  ],
  system: [{ type: "text", text: "You are Claude Code." }],
  metadata: { user_id: "u" },
  max_tokens: 64000,
  thinking: { type: "adaptive", display: "omitted" },
  context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
  safeguards: SAFEGUARDS,
  output_config: { effort: "medium" },
  stream: true,
  ...extra,
});

function snowflakeCreds(psd = {}) {
  const credentials = { apiKey: "k", providerSpecificData: { apiType: "chat", baseUrl: BASE, modelRoutes: { [MODEL]: "anthropic" }, ...psd } };
  credentials.runtimeTransport = resolveCompatibleRoute(SNOWFLAKE, MODEL, credentials);
  return credentials;
}
const compatCreds = (baseUrl, clientBeta = CLIENT_BETAS) => ({
  apiKey: "k",
  providerSpecificData: baseUrl ? { baseUrl } : {},
  rawHeaders: clientBeta ? { "anthropic-beta": clientBeta } : {},
});

const sent = (i = 0) => fetchMock.mock.calls[i][1];
const sentBody = (i = 0) => JSON.parse(sent(i).body);
const sentBeta = (i = 0) => sent(i).headers["anthropic-beta"] ?? sent(i).headers["Anthropic-Beta"];
const run = (provider, credentials, body = claudeCodeBody(), model = MODEL) =>
  new DefaultExecutor(provider).execute({ model, body, stream: true, credentials });

beforeEach(() => {
  fetchMock.mockReset();
  saveRequestDetail.mockClear();
});

describe("safeguards on non-Anthropic upstreams", () => {
  it("is not sent on the live Snowflake route; everything else is", async () => {
    fetchMock.mockResolvedValueOnce(res(200));
    const body = claudeCodeBody();
    await run(SNOWFLAKE, { ...snowflakeCreds(), rawHeaders: { "anthropic-beta": `context-management-2025-06-27,${CLIENT_BETAS}` } }, body);

    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/messages`);
    const out = sentBody();
    expect(out).not.toHaveProperty("safeguards");
    expect(out.output_config).toEqual({ effort: "medium" });
    expect(out.thinking).toEqual({ type: "adaptive", display: "omitted" });
    expect(out.context_management).toEqual(body.context_management);
    expect(sentBeta()).toBe("context-management-2025-06-27,effort-2025-11-24");
  });

  it.each([["a third-party gateway", "https://gateway.example.com/v1"], ...RELAYS.map((u) => [`relay ${u}`, u])])(
    "is not sent to %s, nor is its beta",
    async (_label, baseUrl) => {
      fetchMock.mockResolvedValueOnce(res(200));
      await run("anthropic-compatible-gw", compatCreds(baseUrl));
      expect(sentBody()).not.toHaveProperty("safeguards");
      expect(sentBeta()).toBe("effort-2025-11-24");
    },
  );

  it("is not sent to a built-in third-party Claude-format provider, and the caller's body keeps it", async () => {
    fetchMock.mockResolvedValueOnce(res(200));
    const body = claudeCodeBody({ model: "glm-5" });
    await run("glm", { apiKey: "k" }, body, "glm-5");
    expect(sentBody()).not.toHaveProperty("safeguards");
    // A combo falling back to Anthropic next still has the original field.
    expect(body.safeguards).toEqual(SAFEGUARDS);
  });

  it("goes when its beta is dropped", () => {
    expect(stripBetaBodyFields(claudeCodeBody(), { dropped: [DANGEROUS_BETA] })).not.toHaveProperty("safeguards");
    expect(stripBetaBodyFields(claudeCodeBody(), { dropped: ["oauth-2025-04-20"] }).safeguards).toEqual(SAFEGUARDS);
  });
});

describe("safeguards on Anthropic's own API", () => {
  it.each([
    ["the default base URL", undefined],
    ["api.anthropic.com", "https://api.anthropic.com/v1"],
  ])("is sent with its beta on a custom endpoint at %s", async (_label, baseUrl) => {
    fetchMock.mockResolvedValueOnce(res(200));
    await run("anthropic-compatible-official", compatCreds(baseUrl));
    expect(sentBody().safeguards).toEqual(SAFEGUARDS);
    expect(sentBeta()).toBe(CLIENT_BETAS);
  });

  it("is not sent when the client's beta isn't forwarded", async () => {
    fetchMock.mockResolvedValueOnce(res(200));
    await run("anthropic-compatible-official", compatCreds("https://api.anthropic.com/v1", "effort-2025-11-24"));
    expect(sentBody()).not.toHaveProperty("safeguards");
  });

  // Their fixed beta lists don't carry dangerous-tool-use, so the field would go out ungated.
  it("is not sent by the claude provider; context_management (beta in its list) is", async () => {
    fetchMock.mockResolvedValueOnce(res(200));
    await run("claude", { accessToken: "t" });
    expect(sentBody()).not.toHaveProperty("safeguards");
    expect(sentBody().context_management).toEqual(claudeCodeBody().context_management);
  });

  it("is not sent by the anthropic provider, nor ungated context_management", async () => {
    fetchMock.mockResolvedValueOnce(res(200));
    await run("anthropic", { apiKey: "k" });
    expect(sentBody()).not.toHaveProperty("safeguards");
    expect(sentBody()).not.toHaveProperty("context_management");
  });
});

describe("third-party identity headers", () => {
  it("a gateway gets Bearer auth too; Anthropic's host does not", async () => {
    fetchMock.mockResolvedValue(res(200));
    await run("anthropic-compatible-gw", compatCreds("https://gateway.example.com/v1"));
    await run("anthropic-compatible-official", compatCreds("https://api.anthropic.com/v1"));
    expect(sent(0).headers.Authorization).toMatch(/^Bearer /);
    expect(sent(1).headers).not.toHaveProperty("Authorization");
  });
});

describe("helpers", () => {
  it("isAnthropicApiUrl matches the host only", () => {
    expect(isAnthropicApiUrl("https://api.anthropic.com/v1")).toBe(true);
    for (const u of [...RELAYS, "api.anthropic.com/v1", "", undefined]) expect(isAnthropicApiUrl(u)).toBe(false);
  });

  it("stripUngatedBodyFields reads the beta header in any case and copies", () => {
    const body = claudeCodeBody();
    expect(stripUngatedBodyFields(body, { "Anthropic-Beta": `${DANGEROUS_BETA},context-management-2025-06-27` })).toBe(body);
    const out = stripUngatedBodyFields(body, { "anthropic-beta": "context-management-2025-06-27" });
    expect(out).not.toHaveProperty("safeguards");
    expect(out.context_management).toEqual(body.context_management);
    expect(body.safeguards).toEqual(SAFEGUARDS);
  });
});

const chat = (body, headers = {}) => handleChatCore({
  body, modelInfo: { provider: SNOWFLAKE, model: MODEL },
  credentials: { apiKey: "k", providerSpecificData: { apiType: "chat", baseUrl: BASE, modelRoutes: { [MODEL]: "anthropic" } } },
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() }, connectionId: "c",
  clientRawRequest: {
    endpoint: "/v1/messages", body,
    headers: { "user-agent": "claude-cli/2.1.312 (external, cli)", accept: "application/json", "anthropic-beta": CLIENT_BETAS, ...headers },
  },
});

describe("Claude Code → Snowflake through chatCore (claude→claude)", () => {
  it("sends no safeguards upstream", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      id: "msg_1", type: "message", role: "assistant", model: MODEL,
      content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const result = await chat(claudeCodeBody({ stream: false }));

    expect(result.success).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/messages`);
    expect(sentBody()).not.toHaveProperty("safeguards");
    expect(sentBody().output_config).toEqual({ effort: "medium" });
  });

  it("logs the stripped body when the upstream call throws", async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" }));
    await chat(claudeCodeBody({ stream: false }));

    expect(saveRequestDetail).toHaveBeenCalledTimes(1);
    const { providerRequest } = saveRequestDetail.mock.calls[0][0];
    expect(providerRequest.output_config).toEqual({ effort: "medium" });
    expect(providerRequest).not.toHaveProperty("safeguards");
  });
});
