// Claude Code 2.1.312 in auto mode adds a top-level `safeguards` field (its
// server-side classifier input, behind dangerous-tool-use-2026-09-03). Live
// failure (2026-10-29, Snowflake Cortex node, claude-opus-5-5 routed to /messages):
//   400 {"message":"safeguards: Extra inputs are not permitted"}
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
const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
const { resolveCompatibleRoute } = await import("../../open-sse/services/provider.js");
const { stripBetaBodyFields } = await import("../../open-sse/utils/anthropicBeta.js");
const { parseRejectedFields, resetRejectedFields } = await import("../../open-sse/utils/rejectedFields.js");

const SNOWFLAKE = "openai-compatible-chat-eea96964-59c9-40ee-b64e-9e3bed15b7cb";
const BASE = "https://acme.snowflakecomputing.com/api/v2/cortex/v1";
const MODEL = "claude-opus-5-5";
const DANGEROUS_BETA = "dangerous-tool-use-2026-09-03";
const SAFEGUARDS = [{ type: "dangerous_tool_use", classifier_context: { v: 1, permission_mode: "auto" } }];
const extra400 = (...fields) => JSON.stringify({ message: fields.map((f) => `${f}: Extra inputs are not permitted`).join("\n") });

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
const anthropicCompatCreds = (baseUrl) => ({ apiKey: "k", providerSpecificData: baseUrl ? { baseUrl } : {} });

const sentBody = (i = 0) => JSON.parse(fetchMock.mock.calls[i][1].body);
const run = (provider, credentials, body = claudeCodeBody(), model = MODEL) =>
  new DefaultExecutor(provider).execute({ model, body, stream: true, credentials, log: { warn: vi.fn() } });

beforeEach(() => {
  fetchMock.mockReset();
  resetRejectedFields();
});

describe("safeguards on non-Anthropic Messages upstreams", () => {
  it("is not sent on the live Snowflake route; everything else is", async () => {
    fetchMock.mockResolvedValueOnce(res(200));
    const body = claudeCodeBody();
    await run(SNOWFLAKE, snowflakeCreds(), body);

    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/messages`);
    const sent = sentBody();
    expect(sent).not.toHaveProperty("safeguards");
    expect(sent.output_config).toEqual({ effort: "medium" });
    expect(sent.thinking).toEqual({ type: "adaptive", display: "omitted" });
    expect(sent.context_management).toEqual(body.context_management);
    expect(body.safeguards).toEqual(SAFEGUARDS);
  });

  it("is not sent to a third-party anthropic-compatible gateway", async () => {
    fetchMock.mockResolvedValueOnce(res(200));
    await run("anthropic-compatible-gw", anthropicCompatCreds("https://gateway.example.com/v1"));
    expect(sentBody()).not.toHaveProperty("safeguards");
  });

  it("is not sent to a built-in third-party Claude-format provider", async () => {
    fetchMock.mockResolvedValueOnce(res(200));
    await run("glm", { apiKey: "k" }, claudeCodeBody({ model: "glm-5" }), "glm-5");
    expect(sentBody()).not.toHaveProperty("safeguards");
  });

  it("goes when its beta is dropped, even on Anthropic", () => {
    expect(stripBetaBodyFields(claudeCodeBody(), { dropped: [DANGEROUS_BETA] })).not.toHaveProperty("safeguards");
    expect(stripBetaBodyFields(claudeCodeBody(), { dropped: ["oauth-2025-04-20"] }).safeguards).toEqual(SAFEGUARDS);
  });
});

describe("safeguards on Anthropic's own API", () => {
  it.each([
    ["anthropic", { apiKey: "k" }],
    ["claude", { accessToken: "t" }],
    ["anthropic-compatible-default", anthropicCompatCreds()],
    ["anthropic-compatible-official", anthropicCompatCreds("https://api.anthropic.com/v1")],
  ])("is kept for %s", async (provider, credentials) => {
    fetchMock.mockResolvedValueOnce(res(200));
    await run(provider, credentials);
    expect(sentBody().safeguards).toEqual(SAFEGUARDS);
  });

  it("never self-heals there", async () => {
    fetchMock.mockResolvedValueOnce(res(400, extra400("speed")));
    const out = await run("anthropic-compatible-official", anthropicCompatCreds("https://api.anthropic.com/v1"), claudeCodeBody({ speed: "fast" }));
    expect(out.response.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("parseRejectedFields", () => {
  it("reads every top-level field the error names", () => {
    expect(parseRejectedFields(extra400("safeguards"))).toEqual(["safeguards"]);
    expect(parseRejectedFields(extra400("diagnostics", "thread"))).toEqual(["diagnostics", "thread"]);
  });
  it("ignores nested fields, core fields, and other errors", () => {
    expect(parseRejectedFields(extra400("messages.0.content.0.safeguards"))).toEqual([]);
    expect(parseRejectedFields(extra400("model", "messages", "max_tokens"))).toEqual([]);
    expect(parseRejectedFields("{\"message\":\"max_tokens: Field required\"}")).toEqual([]);
    expect(parseRejectedFields("")).toEqual([]);
  });
});

describe("self-heal on 'Extra inputs are not permitted'", () => {
  it("drops the named field, retries once, and leaves it off next time", async () => {
    fetchMock.mockResolvedValueOnce(res(400, extra400("diagnostics"))).mockResolvedValueOnce(res(200));
    const body = claudeCodeBody({ diagnostics: { previous_message_id: "msg_0" } });
    const out = await run(SNOWFLAKE, snowflakeCreds(), body);

    expect(out.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentBody(0).diagnostics).toEqual({ previous_message_id: "msg_0" });
    expect(sentBody(1)).not.toHaveProperty("diagnostics");
    expect(sentBody(1).output_config).toEqual({ effort: "medium" });
    expect(body.diagnostics).toEqual({ previous_message_id: "msg_0" });

    fetchMock.mockResolvedValueOnce(res(200));
    await run(SNOWFLAKE, snowflakeCreds(), claudeCodeBody({ diagnostics: { previous_message_id: "msg_1" } }));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sentBody(2)).not.toHaveProperty("diagnostics");
  });

  it("remembers per provider and model", async () => {
    fetchMock.mockResolvedValueOnce(res(400, extra400("speed"))).mockResolvedValueOnce(res(200));
    await run("anthropic-compatible-gw", anthropicCompatCreds("https://gateway.example.com/v1"), claudeCodeBody({ speed: "fast" }));

    fetchMock.mockResolvedValueOnce(res(200)).mockResolvedValueOnce(res(200));
    await run("anthropic-compatible-gw", anthropicCompatCreds("https://gateway.example.com/v1"), claudeCodeBody({ model: "claude-haiku-4-5", speed: "fast" }), "claude-haiku-4-5");
    await run("anthropic-compatible-other", anthropicCompatCreds("https://other.example.com/v1"), claudeCodeBody({ speed: "fast" }));
    expect(sentBody(2).speed).toBe("fast");
    expect(sentBody(3).speed).toBe("fast");
  });

  it("does not loop when the retry is rejected too", async () => {
    fetchMock.mockResolvedValueOnce(res(400, extra400("speed"))).mockResolvedValueOnce(res(400, extra400("thread")));
    const out = await run(SNOWFLAKE, snowflakeCreds(), claudeCodeBody({ speed: "fast", thread: { id: "t" } }));
    expect(out.response.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // What the second error named is still learned.
    fetchMock.mockResolvedValueOnce(res(200));
    await run(SNOWFLAKE, snowflakeCreds(), claudeCodeBody({ speed: "fast", thread: { id: "t" } }));
    expect(sentBody(2)).not.toHaveProperty("speed");
    expect(sentBody(2)).not.toHaveProperty("thread");
  });

  it.each([
    ["an unrelated 400", "{\"message\":\"messages: at least one message is required\"}"],
    ["a nested field", extra400("messages.1.content.0.safeguards")],
    ["a field the body doesn't carry", extra400("thread")],
    ["a core field", extra400("max_tokens")],
  ])("leaves %s alone", async (_label, text) => {
    fetchMock.mockResolvedValueOnce(res(400, text));
    const out = await run(SNOWFLAKE, snowflakeCreds());
    expect(out.response.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("works alongside a beta rejection on the retry", async () => {
    const beta400 = `{"message":"Unexpected value(s) \`${DANGEROUS_BETA}\` for the \`anthropic-beta\` header. Please consult our documentation at platform.claude.com/docs or try again without the header."}`;
    fetchMock
      .mockResolvedValueOnce(res(400, extra400("speed")))
      .mockResolvedValueOnce(res(400, beta400))
      .mockResolvedValueOnce(res(200));
    const onBetasRejected = vi.fn();
    const credentials = { ...snowflakeCreds(), rawHeaders: { "anthropic-beta": `${DANGEROUS_BETA},effort-2025-11-24` } };
    const out = await new DefaultExecutor(SNOWFLAKE).execute({ model: MODEL, body: claudeCodeBody({ speed: "fast" }), stream: true, credentials, onBetasRejected });

    expect(out.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][1].headers["anthropic-beta"]).toBe("effort-2025-11-24");
    expect(sentBody(2)).not.toHaveProperty("speed");
    expect(onBetasRejected).toHaveBeenCalledWith([DANGEROUS_BETA]);
    expect(out.droppedBetas).toEqual([DANGEROUS_BETA]);
  });
});

describe("Claude Code → Snowflake through chatCore (claude→claude)", () => {
  it("sends no safeguards upstream", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      id: "msg_1", type: "message", role: "assistant", model: MODEL,
      content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const body = claudeCodeBody({ stream: false });
    const result = await handleChatCore({
      body, modelInfo: { provider: SNOWFLAKE, model: MODEL },
      credentials: { apiKey: "k", providerSpecificData: { apiType: "chat", baseUrl: BASE, modelRoutes: { [MODEL]: "anthropic" } } },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() }, connectionId: "c",
      clientRawRequest: {
        endpoint: "/v1/messages", body,
        headers: { "user-agent": "claude-cli/2.1.312 (external, cli)", accept: "application/json", "anthropic-beta": `${DANGEROUS_BETA},effort-2025-11-24` },
      },
    });

    expect(result.success).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/messages`);
    const sent = sentBody();
    expect(sent).not.toHaveProperty("safeguards");
    expect(sent.output_config).toEqual({ effort: "medium" });
  });
});
