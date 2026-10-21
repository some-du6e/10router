// Runtime behaviour of user-added OpenAI/Anthropic-compatible endpoints
// (PR #89 review): two-path routing, anthropic-beta forwarding, URL building,
// request-error account locking.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));
const fetchMock = vi.fn();

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...a) => fetchMock(...a) }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn(), logOpenAIRequest: vi.fn(),
  }),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}), saveRequestDetail: vi.fn(async () => {}),
}));

const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
const { resolveCompatibleRoute, appendUrlPath } = await import("../../open-sse/services/provider.js");
const { isRequestError } = await import("../../open-sse/services/accountFallback.js");

const BASE = "https://acme.snowflakecomputing.com/api/v2/cortex/v1";
const SNOWFLAKE_400 = (flags) => JSON.stringify({ message: `Unexpected value(s) ${flags.map((f) => `\`${f}\``).join(", ")} for the \`anthropic-beta\` header. Please consult our documentation.` });

function res(status, text = "") {
  return { status, ok: status >= 200 && status < 300, headers: { get: () => "" }, clone: () => ({ text: async () => text }), body: { cancel: async () => {} } };
}
const beta = (call) => call[1].headers["anthropic-beta"] ?? call[1].headers["Anthropic-Beta"];

beforeEach(() => { fetchMock.mockReset(); executeMock.mockReset(); });

describe("Claude Code on a two-path node", () => {
  it("translates a model routed to /chat/completions instead of passing the Claude body through", async () => {
    vi.resetModules();
    vi.doMock("../../open-sse/executors/index.js", () => ({ getExecutor: () => ({ execute: executeMock }) }));
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    executeMock.mockResolvedValue({ response: new Response("{}", { status: 200, headers: { "content-type": "application/json" } }), url: "", headers: {}, transformedBody: {} });
    const body = { model: "kimi-k3", max_tokens: 50, stream: false, system: "be nice", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };
    const credentials = { apiKey: "k", providerSpecificData: { baseUrl: BASE, modelRoutes: { "kimi-k3": "openai-chat" } } };
    await handleChatCore({
      body, modelInfo: { provider: "anthropic-compatible-sf", model: "kimi-k3" }, credentials,
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() }, connectionId: "c",
      clientRawRequest: { endpoint: "/v1/messages", body, headers: { "user-agent": "claude-cli/2.1.0 (external, cli)", accept: "application/json" } },
    });
    const { body: sent, credentials: sentCreds } = executeMock.mock.calls[0][0];
    expect(sentCreds.runtimeTransport.baseUrl).toBe(`${BASE}/chat/completions`);
    expect(sent.system).toBeUndefined();
    expect(sent.messages[0]).toEqual({ role: "system", content: "be nice" });
    vi.doUnmock("../../open-sse/executors/index.js");
  });
});

describe("anthropic-beta forwarding", () => {
  const creds = (psd = {}, rt = null) => ({
    apiKey: "k",
    rawHeaders: { "anthropic-beta": "claude-code-20250219,context-1m-2025-08-07,oauth-2025-04-20" },
    providerSpecificData: { baseUrl: BASE, ...psd },
    ...(rt ? { runtimeTransport: rt } : {}),
  });

  it("forwards the client's flags to an anthropic-compatible node, minus claude-code", async () => {
    fetchMock.mockResolvedValueOnce(res(200));
    await new DefaultExecutor("anthropic-compatible-sf").execute({ model: "m", body: {}, stream: false, credentials: creds() });
    expect(beta(fetchMock.mock.calls[0])).toBe("context-1m-2025-08-07,oauth-2025-04-20");
  });

  it("forwards on an openai node's Messages route, never on its Chat route", async () => {
    fetchMock.mockResolvedValue(res(200));
    const c1 = creds({ modelRoutes: { claude: "anthropic" } });
    c1.runtimeTransport = resolveCompatibleRoute("openai-compatible-chat-sf", "claude", c1);
    await new DefaultExecutor("openai-compatible-chat-sf").execute({ model: "claude", body: {}, stream: false, credentials: c1 });
    expect(beta(fetchMock.mock.calls[0])).toBe("context-1m-2025-08-07,oauth-2025-04-20");

    const c2 = creds({ modelRoutes: { gpt: "openai-chat" } });
    c2.runtimeTransport = resolveCompatibleRoute("anthropic-compatible-sf", "gpt", c2);
    await new DefaultExecutor("anthropic-compatible-sf").execute({ model: "gpt", body: {}, stream: false, credentials: c2 });
    expect(beta(fetchMock.mock.calls[1])).toBeUndefined();

    await new DefaultExecutor("openai-compatible-chat-sf").execute({ model: "x", body: {}, stream: false, credentials: creds() });
    expect(beta(fetchMock.mock.calls[2])).toBeUndefined();
  });

  it("keeps dropping flags across rejections, then strips all, and records the union", async () => {
    fetchMock
      .mockResolvedValueOnce(res(400, SNOWFLAKE_400(["oauth-2025-04-20"])))
      .mockResolvedValueOnce(res(400, SNOWFLAKE_400(["context-1m-2025-08-07"])))
      .mockResolvedValueOnce(res(200));
    const onBetasRejected = vi.fn();
    const out = await new DefaultExecutor("anthropic-compatible-sf").execute({ model: "m", body: {}, stream: false, credentials: creds(), onBetasRejected });
    expect(out.response.status).toBe(200);
    expect(fetchMock.mock.calls.map(beta)).toEqual(["context-1m-2025-08-07,oauth-2025-04-20", "context-1m-2025-08-07", undefined]);
    expect(onBetasRejected).toHaveBeenCalledTimes(1);
    expect(onBetasRejected).toHaveBeenCalledWith(["oauth-2025-04-20", "context-1m-2025-08-07"]);
  });

  it("is bounded: a gateway that keeps rejecting gets at most one beta-less retry", async () => {
    fetchMock.mockImplementation(async (_u, init) => {
      const flags = (init.headers["anthropic-beta"] || "").split(",").filter(Boolean);
      return flags.length ? res(400, SNOWFLAKE_400([flags[0]])) : res(400, "{\"message\":\"bad body\"}");
    });
    const onBetasRejected = vi.fn();
    const many = { apiKey: "k", rawHeaders: { "anthropic-beta": "a-1,b-2,c-3,d-4,e-5" }, providerSpecificData: { baseUrl: BASE } };
    const out = await new DefaultExecutor("anthropic-compatible-sf").execute({ model: "m", body: {}, stream: false, credentials: many, onBetasRejected });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(beta(fetchMock.mock.calls[2])).toBeUndefined();
    expect(out.response.status).toBe(400);
    expect(onBetasRejected).toHaveBeenCalledWith(["a-1", "b-2"]);
  });
});

describe("base URLs with a query string", () => {
  it("puts the API path before the query", () => {
    expect(appendUrlPath("https://x.azure.com/openai/v1?api-version=2025-01-01", "/chat/completions"))
      .toBe("https://x.azure.com/openai/v1/chat/completions?api-version=2025-01-01");
    const c = { providerSpecificData: { baseUrl: "https://x.azure.com/openai/v1/?api-version=2025-01-01", modelRoutes: { claude: "anthropic" } } };
    expect(resolveCompatibleRoute("openai-compatible-chat-x", "claude", c).baseUrl).toBe("https://x.azure.com/openai/v1/messages?api-version=2025-01-01");
  });
  it("applies to the node's own path too", () => {
    const ex = new DefaultExecutor("openai-compatible-chat-x");
    expect(ex.buildUrl("m", false, 0, { providerSpecificData: { baseUrl: "https://x.azure.com/v1?api-version=1" } }))
      .toBe("https://x.azure.com/v1/chat/completions?api-version=1");
    expect(new DefaultExecutor("anthropic-compatible-x").buildUrl("m", false, 0, { providerSpecificData: { baseUrl: "https://x/v1?k=1" } }))
      .toBe("https://x/v1/messages?k=1");
  });
});

describe("isRequestError", () => {
  it("treats 400/404/422 as request errors unless the text says limit/quota", () => {
    expect(isRequestError(400, "messages: tool_result must follow tool_use")).toBe(true);
    expect(isRequestError(422, "")).toBe(true);
    expect(isRequestError(404, "unknown model")).toBe(true);
    expect(isRequestError(400, "Rate limit exceeded")).toBe(false);
    expect(isRequestError(401, "bad key")).toBe(false);
    expect(isRequestError(403, "")).toBe(false);
    expect(isRequestError(429, "")).toBe(false);
  });
  it("still locks an account that is out of credit (Anthropic 400)", () => {
    expect(isRequestError(400, '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}')).toBe(false);
    // Broad words alone (a prompt echoed in the error) don't lock the key.
    expect(isRequestError(400, '{"error":{"message":"Invalid field in: summarize my billing history and usage limits"}}')).toBe(true);
    expect(isRequestError(400, '{"error":{"code":"billing_hard_limit_reached"}}')).toBe(false);
  });
  it("still locks a key the upstream reports as invalid with a 400 (Gemini)", () => {
    expect(isRequestError(400, '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}')).toBe(false);
    expect(isRequestError(400, { error: { code: "invalid_api_key" } })).toBe(false);
  });
});
