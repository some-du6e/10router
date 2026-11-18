// Per-request state that must not leak between requests or clients on the
// upstream path: Codex's compact endpoint, model ids placed in URL paths, and
// Kiro's session replay.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...a) => fetchMock(...a) }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(), logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(), logError: vi.fn(), logOpenAIRequest: vi.fn(), appendConvertedChunk: vi.fn(),
  }),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}),
}));

const { getExecutor } = await import("../../open-sse/executors/index.js");
const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
const { VertexExecutor } = await import("../../open-sse/executors/vertex.js");
const { AzureExecutor } = await import("../../open-sse/executors/azure.js");
const { clearKiroSessionReplayStore } = await import("../../open-sse/utils/kiroSessionReplay.js");
const { clearSessionStore } = await import("../../open-sse/utils/sessionManager.js");
const { openaiToKiroRequest } = await import("../../open-sse/translator/request/openai-to-kiro.js");
const { claudeToKiroRequest } = await import("../../open-sse/translator/request/claude-to-kiro.js");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { modelPathSegment, modelPathSegments } = await import("../../open-sse/utils/modelPath.js");
const { default: cloudflareImages } = await import("../../open-sse/handlers/imageProviders/cloudflareAi.js");
const { default: geminiImages } = await import("../../open-sse/handlers/imageProviders/gemini.js");
const { default: geminiEmbeddings } = await import("../../open-sse/handlers/embeddingProviders/gemini.js");
const { handleSttCore } = await import("../../open-sse/handlers/sttCore.js");

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// The path a URL reaches, as the upstream's URL parser resolves it.
const target = (url) => new URL(url).pathname;

const sse = () => new Response(
  "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{}}\n\n",
  { status: 200, headers: { "content-type": "text/event-stream" } },
);

beforeEach(() => { fetchMock.mockReset(); });

describe("Codex compact", () => {
  it("sends each request to the endpoint its own body asks for", async () => {
    fetchMock.mockImplementation(async () => sse());
    const codex = getExecutor("codex");
    const call = (compact) => codex.execute({
      model: "gpt-5.3-codex",
      body: { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }], ...(compact ? { _compact: true } : {}) },
      stream: true,
      credentials: { accessToken: "t", connectionId: "c" },
    });
    await call(false);
    await call(true);
    await call(false);
    const urls = fetchMock.mock.calls.map(([url]) => url);
    expect(urls[0]).toMatch(/\/responses$/);
    expect(urls[1]).toMatch(/\/responses\/compact$/);
    expect(urls[2]).toMatch(/\/responses$/);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)._compact).toBeUndefined();
  });

  it("keeps a retry with the same body on the compact endpoint", async () => {
    fetchMock.mockImplementation(async () => sse());
    const codex = getExecutor("codex");
    const body = { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }], _compact: true };
    const args = { model: "gpt-5.3-codex", body, stream: true, credentials: { accessToken: "t", connectionId: "c" } };
    await codex.execute(args);
    await codex.execute(args);
    const urls = fetchMock.mock.calls.map(([url]) => url);
    expect(urls).toHaveLength(2);
    for (const url of urls) expect(url).toMatch(/\/responses\/compact$/);
  });
});

describe("model ids in upstream URL paths", () => {
  const crafted = "x/../gemini-2.5-pro:generateContent#/y";

  it("keep a crafted Gemini model id as one path segment", () => {
    const url = new DefaultExecutor("gemini").buildUrl(crafted, false);
    expect(target(url)).toBe("/v1beta/models/x%2F..%2Fgemini-2.5-pro:generateContent%23%2Fy:generateContent");
    expect(new DefaultExecutor("gemini").buildUrl("gemini-2.5-pro", true))
      .toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse");
  });

  it("keep it as one segment on Vertex and Azure too", () => {
    const vertex = new VertexExecutor().buildUrl(crafted, false, 0, { apiKey: "raw-key" });
    expect(target(vertex)).toBe("/v1/publishers/google/models/x%2F..%2Fgemini-2.5-pro:generateContent%23%2Fy:generateContent");
    const azure = new AzureExecutor().buildUrl("a/../../other?x=1#", false, 0, { providerSpecificData: { azureEndpoint: "https://r.example" } });
    expect(target(azure)).toBe("/openai/deployments/a%2F..%2F..%2Fother%3Fx%3D1%23/chat/completions");
  });

  it("refuse an id that is only dots", () => {
    expect(() => new DefaultExecutor("gemini").buildUrl("..", false)).toThrow(/Invalid model id/);
    expect(() => new AzureExecutor().buildUrl(".", false, 0, {})).toThrow(/Invalid model id/);
  });

  it("keep it as one segment on Vertex's project-scoped (OAuth) path", () => {
    const url = new VertexExecutor().buildUrl(crafted, true, 0, { accessToken: "t", providerSpecificData: { projectId: "project-1" } });
    expect(target(url)).toBe("/v1/projects/project-1/locations/us-central1/publishers/google/models/x%2F..%2Fgemini-2.5-pro:generateContent%23%2Fy:streamGenerateContent");
  });

  it("keep it as one segment for Gemini images and embeddings", () => {
    expect(target(geminiImages.buildUrl(`models/${crafted}`, { apiKey: "k" })))
      .toBe("/v1beta/models/x%2F..%2Fgemini-2.5-pro:generateContent%23%2Fy:generateContent");
    expect(target(geminiEmbeddings.buildUrl("models/x/../text-embedding?y#", { apiKey: "k" }, { input: "a" })))
      .toBe("/v1beta/models/x%2F..%2Ftext-embedding%3Fy%23:embedContent");
    expect(geminiEmbeddings.buildUrl("text-embedding-004", { apiKey: "k" }, { input: ["a", "b"] }))
      .toBe("https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:batchEmbedContents?key=k");
    // The body names the same model as the URL, as the resource name Gemini expects.
    expect(geminiEmbeddings.buildBody("models/text-embedding-004", { input: ["a"] }).requests[0].model).toBe("models/text-embedding-004");
    expect(geminiEmbeddings.buildBody("text-embedding-004", { input: "a" }).model).toBe("models/text-embedding-004");
    expect(() => geminiEmbeddings.buildUrl("models/..", { apiKey: "k" }, { input: "a" })).toThrow(/Invalid model id/);
  });
});

describe("model path helpers", () => {
  it("modelPathSegment escapes everything but : and @, and refuses dot segments, encoded or not", () => {
    expect(modelPathSegment("vendor/model:v1@2025?#")).toBe("vendor%2Fmodel:v1@2025%3F%23");
    for (const bad of ["", ".", "..", "%2e", "%2E%2e", ".%2E", null, undefined]) {
      expect(() => modelPathSegment(bad)).toThrow(/Invalid model id/);
    }
    expect(modelPathSegment("a%2eb")).toBe("a%252eb");
  });

  it("modelPathSegments keeps / between segments and escapes each one", () => {
    expect(modelPathSegments("@cf/vendor/model-1")).toBe("@cf/vendor/model-1");
    expect(modelPathSegments("org/model name?x#y")).toBe("org/model%20name%3Fx%23y");
    expect(modelPathSegments("org/%2e%2ex")).toBe("org/%252e%252ex");
    for (const bad of ["", "/org/model", "org/model/", "org//model", "org/./model", "org/../model", "org/%2e%2e/model", "org/%2E./model", "org/.%2e", "%2e/model"]) {
      expect(() => modelPathSegments(bad)).toThrow(/Invalid model id/);
    }
  });

  it("a Cloudflare image model reaches only its own path", () => {
    const creds = { providerSpecificData: { accountId: "account-1" } };
    expect(target(cloudflareImages.buildUrl("@cf/vendor/model one", creds))).toBe("/client/v4/accounts/account-1/ai/run/@cf/vendor/model%20one");
    expect(target(cloudflareImages.buildUrl("@cf/vendor/x?y#z", creds))).toBe("/client/v4/accounts/account-1/ai/run/@cf/vendor/x%3Fy%23z");
    expect(() => cloudflareImages.buildUrl("@cf/../../other-account/ai/run/x", creds)).toThrow(/Invalid model id/);
    expect(() => cloudflareImages.buildUrl("@cf/%2e%2e/x", creds)).toThrow(/Invalid model id/);
  });

  it("a Hugging Face speech-to-text model reaches only its own path", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url) => { calls.push(url); return new Response(JSON.stringify({ text: "ok" }), { status: 200 }); }));
    const run = (model) => {
      const formData = new FormData();
      formData.append("file", new File([new Uint8Array([1, 2, 3])], "a.wav", { type: "audio/wav" }));
      return handleSttCore({ provider: "huggingface", model, formData, credentials: { apiKey: "k" }, sttConfig: { format: "huggingface-asr", baseUrl: "https://hf.example/models/", authType: "bearer" } });
    };
    const ok = await run("org/speech model");
    expect(ok.success).not.toBe(false);
    expect(target(calls[0])).toBe("/models/org/speech%20model");
    for (const bad of ["org/../other", "org/%2e%2e/other", "org//x"]) {
      const res = await run(bad);
      expect(res.status).toBe(400);
    }
    expect(calls).toHaveLength(1);
  });
});

describe("Kiro session replay", () => {
  beforeEach(() => { clearKiroSessionReplayStore(); clearSessionStore(); });

  const first = { messages: [{ role: "user", content: "KEY-A SECRET first prompt" }] };
  const later = { messages: [{ role: "user", content: "key B first" }, { role: "assistant", content: "hi B" }, { role: "user", content: "repeat my first message" }] };
  const creds = (clientScope) => ({ connectionId: "conn-kiro", clientScope, rawHeaders: { "x-session-id": "shared-sid" } });
  const history = (req) => JSON.stringify(req.conversationState.history);

  it("never replays one client key's first message into another key's session", () => {
    const a = openaiToKiroRequest("claude-sonnet-4.5", first, true, creds("key-a"));
    const b = openaiToKiroRequest("claude-sonnet-4.5", later, true, creds("key-b"));
    expect(history(b)).not.toContain("KEY-A SECRET");
    expect(history(b)).toContain("key B first");
    expect(b.conversationState.agentContinuationId).not.toBe(a.conversationState.agentContinuationId);
  });

  it("still replays within the same key's session", () => {
    openaiToKiroRequest("claude-sonnet-4.5", first, true, creds("key-a"));
    const again = openaiToKiroRequest("claude-sonnet-4.5", later, true, creds("key-a"));
    expect(history(again)).toContain("KEY-A SECRET");
  });

  it("keeps Claude-format requests apart per client key too", () => {
    const a = claudeToKiroRequest("claude-sonnet-4.5", first, true, creds("key-a"));
    const b = claudeToKiroRequest("claude-sonnet-4.5", later, true, creds("key-b"));
    expect(history(b)).not.toContain("KEY-A SECRET");
    expect(history(b)).toContain("key B first");
    expect(b.conversationState.agentContinuationId).not.toBe(a.conversationState.agentContinuationId);
    const again = claudeToKiroRequest("claude-sonnet-4.5", later, true, creds("key-a"));
    expect(history(again)).toContain("KEY-A SECRET");
  });
});

describe("the client scope chatCore hands the executor", () => {
  async function scopeFor(apiKey) {
    let seen;
    vi.spyOn(getExecutor("openrouter"), "execute").mockImplementationOnce(async ({ credentials }) => {
      seen = credentials.clientScope;
      return { response: new Response(JSON.stringify({ id: "c1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } }), url: "https://upstream.example", headers: {}, transformedBody: null };
    });
    const body = { model: "openrouter/model-a", stream: false, messages: [{ role: "user", content: "hi" }] };
    const result = await handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider: "openrouter", model: "model-a" },
      credentials: { apiKey: "upstream-key" },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      connectionId: "conn-a",
      apiKey,
      clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: { accept: "application/json" } },
    });
    expect(result.success).toBe(true);
    return seen;
  }

  it("is a per-key hash, the same for the same key, and local without one", async () => {
    const a = await scopeFor("client-key-a");
    const b = await scopeFor("client-key-b");
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(b).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
    expect(await scopeFor("client-key-a")).toBe(a);
    expect(await scopeFor(null)).toBe("local");
  });
});
