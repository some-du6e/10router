// Two-path custom endpoints: one node, each model routed to the API that
// serves it best (Snowflake Cortex answers on both Messages and Chat).
import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...a) => fetchMock(...a) }));

const { chooseRoute, buildRoutes, detectEndpoint } = await import("@/lib/endpointDetect.js");
const { sanitizeNodeQuirks } = await import("@/shared/utils/nodeQuirks.js");
const { resolveCompatibleRoute } = await import("../../open-sse/services/provider.js");
const { DefaultExecutor } = await import("../../open-sse/executors/default.js");

const BASE = "https://acme.snowflakecomputing.com/api/v2/cortex/v1";

describe("chooseRoute", () => {
  it("keeps Claude on Messages and sends the rest to OpenAI", () => {
    expect(chooseRoute("claude-haiku-4-5", ["anthropic", "openai-chat"])).toBe("anthropic");
    expect(chooseRoute("deepseek-v4-flash", ["anthropic", "openai-chat"])).toBe("openai-chat");
    expect(chooseRoute("openai-gpt-5", ["openai-chat", "openai-responses"])).toBe("openai-responses");
    expect(chooseRoute("kimi-k3", ["openai-chat"])).toBe("openai-chat");
  });
});

describe("buildRoutes", () => {
  it("unions models, picks the busiest path as primary, routes only the rest", () => {
    const r = buildRoutes({
      anthropic: ["claude-opus-5", "claude-haiku-4-5", "deepseek-v4-flash"],
      "openai-chat": ["claude-opus-5", "openai-gpt-5", "kimi-k3", "glm-5.3", "deepseek-v4-flash"],
    });
    expect(r.models.sort()).toEqual(["claude-haiku-4-5", "claude-opus-5", "deepseek-v4-flash", "glm-5.3", "kimi-k3", "openai-gpt-5"]);
    expect(r.primary).toBe("openai-chat");
    expect(r.routes).toEqual({ "claude-opus-5": "anthropic", "claude-haiku-4-5": "anthropic" });
  });
  it("routes against a fixed primary (Import on a saved node)", () => {
    const r = buildRoutes({ anthropic: ["claude-opus-5"], "openai-chat": ["claude-opus-5", "openai-gpt-5"] }, "anthropic");
    expect(r.routes).toEqual({ "openai-gpt-5": "openai-chat" });
  });
});

describe("sanitizeNodeQuirks modelRoutes", () => {
  it("keeps only known paths and sane ids", () => {
    expect(sanitizeNodeQuirks({ modelRoutes: { "openai-gpt-5": "openai-chat", "x": "ftp", "<script>": "anthropic", "a/b:c": "openai-responses" } }))
      .toEqual({ modelRoutes: { "openai-gpt-5": "openai-chat", "a/b:c": "openai-responses" } });
    expect(sanitizeNodeQuirks({ modelRoutes: ["nope"] })).toEqual({});
  });
});

describe("resolveCompatibleRoute", () => {
  const creds = (modelRoutes) => ({ apiKey: "k", providerSpecificData: { baseUrl: BASE, modelRoutes } });
  it("routes an anthropic-compatible node's GPT model to Chat Completions", () => {
    const t = resolveCompatibleRoute("anthropic-compatible-x", "openai-gpt-5", creds({ "openai-gpt-5": "openai-chat" }));
    expect(t).toMatchObject({ format: "openai", baseUrl: `${BASE}/chat/completions`, compatibleRoute: "openai-chat" });
    expect(t.auth.header).toBe("Authorization");
  });
  it("routes an openai-compatible node's Claude model to Messages", () => {
    const t = resolveCompatibleRoute("openai-compatible-chat-x", "claude-opus-5", creds({ "claude-opus-5": "anthropic" }));
    expect(t).toMatchObject({ format: "claude", baseUrl: `${BASE}/messages` });
  });
  it("does nothing for unrouted models, same-path routes, or other providers", () => {
    expect(resolveCompatibleRoute("anthropic-compatible-x", "claude-opus-5", creds({}))).toBeNull();
    expect(resolveCompatibleRoute("anthropic-compatible-x", "claude-opus-5", creds({ "claude-opus-5": "anthropic" }))).toBeNull();
    expect(resolveCompatibleRoute("openai", "gpt-5", creds({ "gpt-5": "anthropic" }))).toBeNull();
  });
});

function res(status, text = "") {
  return { status, ok: status >= 200 && status < 300, headers: { get: () => "" }, clone: () => ({ text: async () => text }) };
}

describe("DefaultExecutor on a routed model", () => {
  beforeEach(() => fetchMock.mockReset());
  it("Chat route: Bearer auth, max_completion_tokens, no anthropic-beta", async () => {
    fetchMock.mockResolvedValueOnce(res(200));
    const ex = new DefaultExecutor("anthropic-compatible-x");
    const credentials = { apiKey: "k", providerSpecificData: { baseUrl: BASE, maxCompletionTokens: true, modelRoutes: { "openai-gpt-5": "openai-chat" } } };
    credentials.runtimeTransport = resolveCompatibleRoute("anthropic-compatible-x", "openai-gpt-5", credentials);
    await ex.execute({ model: "openai-gpt-5", body: { model: "openai-gpt-5", max_tokens: 5, messages: [] }, stream: false, credentials });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/chat/completions`);
    expect(init.headers.Authorization).toBe("Bearer k");
    expect(init.headers["x-api-key"]).toBeUndefined();
    expect(init.headers["anthropic-beta"] ?? init.headers["Anthropic-Beta"]).toBeUndefined();
    const body = JSON.parse(init.body);
    expect(body.max_completion_tokens).toBe(5);
    expect(body.max_tokens).toBeUndefined();
  });
  it("Messages path keeps max_tokens even when the node has maxCompletionTokens", async () => {
    fetchMock.mockResolvedValueOnce(res(200));
    const ex = new DefaultExecutor("anthropic-compatible-x");
    const credentials = { apiKey: "k", providerSpecificData: { baseUrl: BASE, maxCompletionTokens: true } };
    await ex.execute({ model: "claude-haiku-4-5", body: { model: "claude-haiku-4-5", max_tokens: 5, messages: [] }, stream: false, credentials });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/messages`);
    expect(JSON.parse(init.body).max_tokens).toBe(5);
    expect(init.headers["x-api-key"]).toBe("k");
  });
});

// Scripted two-path upstream (Snowflake-shaped).
function upstream({ messages, chat }) {
  return async (url, init) => {
    const { pathname } = new URL(url);
    const body = init.body ? JSON.parse(init.body) : {};
    const good = (init.headers?.authorization || init.headers?.["x-api-key"] || "").includes("good");
    let out = [404, ""];
    if (pathname.endsWith("/messages")) out = !good ? [401, {}] : messages.has(body.model) ? [400, { message: "'messages' must not be empty" }] : [400, { message: `unknown model "${body.model}"` }];
    if (pathname.endsWith("/chat/completions")) out = !good ? [401, {}] : chat.has(body.model) ? [400, { message: "messages: empty" }] : [400, { message: `unknown model "${body.model}"` }];
    return new Response(JSON.stringify(out[1]), { status: out[0], headers: { "content-type": "application/json" } });
  };
}

describe("detectEndpoint on a two-path endpoint", () => {
  it("discovers on both paths and returns routes", async () => {
    const catalog = { providers: [{ id: "snowflake-cortex", name: "Snowflake Cortex", api: "https://${SNOWFLAKE_ACCOUNT}.snowflakecomputing.com/api/v2/cortex/v1", models: ["claude-opus-5", "claude-haiku-4-5", "openai-gpt-5", "kimi-k3"] }], labs: [] };
    const r = await detectEndpoint({
      url: BASE, apiKey: "good-key", catalog,
      fetchFn: upstream({ messages: new Set(["claude-opus-5", "claude-haiku-4-5"]), chat: new Set(["claude-opus-5", "openai-gpt-5", "kimi-k3"]) }),
    });
    expect(r.ok).toBe(true);
    expect(r.protocols).toEqual(["anthropic", "openai-chat"]);
    expect(r.models.sort()).toEqual(["claude-haiku-4-5", "claude-opus-5", "kimi-k3", "openai-gpt-5"]);
    // 2 Claude on Messages vs 2 others on Chat: tie goes to Messages as primary.
    expect(r.protocol).toBe("anthropic");
    expect(r.routes).toEqual({ "openai-gpt-5": "openai-chat", "kimi-k3": "openai-chat" });
  });
});
