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
// Qoder's model config lookup, which goes upstream before the chat request does.
const qoderModelConfig = vi.fn(async () => ({ key: "model-a", max_output_tokens: 100 }));
vi.mock("../../open-sse/services/qoderModels.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getQoderModelConfig: (...a) => qoderModelConfig(...a),
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
const { default: elevenLabs } = await import("../../open-sse/handlers/ttsProviders/elevenlabs.js");
const { KiroExecutor } = await import("../../open-sse/executors/kiro.js");
const { GithubExecutor } = await import("../../open-sse/executors/github.js");
const { MimoFreeExecutor, __test__: mimo } = await import("../../open-sse/executors/mimo-free.js");
const { CodexExecutor } = await import("../../open-sse/executors/codex.js");
const { default: ZedExecutor } = await import("../../open-sse/executors/zed.js");
const { QoderExecutor, __test__: qoder } = await import("../../open-sse/executors/qoder.js");
const { WindsurfExecutor } = await import("../../open-sse/executors/windsurf.js");
const { default: hfImages } = await import("../../open-sse/handlers/imageProviders/huggingface.js");
const { default: falImages } = await import("../../open-sse/handlers/imageProviders/falAi.js");
const { default: bflImages } = await import("../../open-sse/handlers/imageProviders/blackForestLabs.js");
const { default: geminiTts } = await import("../../open-sse/handlers/ttsProviders/gemini.js");
const { FORMAT_HANDLERS: ttsFormats } = await import("../../open-sse/handlers/ttsProviders/genericFormats.js");
const { handleChatSearch } = await import("../../open-sse/handlers/search/chatSearch.js");
const { modelIdProblem } = await import("../../open-sse/utils/modelPath.js");

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

  it("an ElevenLabs voice id reaches only its own text-to-speech path", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url) => { calls.push(url); return new Response(new Uint8Array(2048), { status: 200 }); }));
    // URL parsers read "\" as "/" and resolve "..": unescaped, this would reach /v1/sound-generation.
    await elevenLabs.synthesize("hi", "eleven_v2/..\\..\\v1\\sound-generation", { apiKey: "k" });
    await elevenLabs.synthesize("hi", "eleven_v2/voice?x=1#y", { apiKey: "k" });
    await elevenLabs.synthesize("hi", "plain-voice-id", { apiKey: "k" });
    expect(calls.map(target)).toEqual([
      "/v1/text-to-speech/..%5C..%5Cv1%5Csound-generation",
      "/v1/text-to-speech/voice%3Fx%3D1%23y",
      "/v1/text-to-speech/plain-voice-id",
    ]);
    expect(new URL(calls[1]).search).toBe("");
    for (const bad of ["eleven_v2/..", "eleven_v2/%2e%2E", ".."]) {
      await expect(elevenLabs.synthesize("hi", bad, { apiKey: "k" })).rejects.toThrow(/Invalid model id/);
    }
    expect(calls).toHaveLength(3);
  });
});

describe("executors report the upstream attempt in flight", () => {
  // The value chatCore would hold when each upstream call is made.
  // `seen`: that value at each labelled upstream call. `calls`: every report, in order.
  function recorder() {
    const seen = [];
    const calls = [];
    let current = "unset";
    const shown = (ts) => (ts === "unset" ? "unset" : ts > 0 ? "sent" : 0);
    return {
      hook: (ts) => { current = ts; calls.push(shown(ts)); },
      at: (label) => seen.push([label, shown(current)]),
      get current() { return current; },
      seen,
      calls,
    };
  }

  it("BaseExecutor reports nothing in flight while it backs off before a retry", async () => {
    const r = recorder();
    const executor = new DefaultExecutor("openrouter");
    executor.config = { ...executor.config, retry: { ...executor.config?.retry, 503: { attempts: 1, delayMs: 10 } } };
    fetchMock
      .mockResolvedValueOnce(new Response("overloaded", { status: 503 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    const result = await executor.execute({ model: "model-a", body: { messages: [{ role: "user", content: "hi" }] }, stream: false, credentials: { apiKey: "k" }, onUpstreamAttempt: r.hook });
    expect(result.response.ok).toBe(true);
    expect(r.calls).toEqual(["sent", 0, "sent"]);
  });

  it("Vertex reports nothing in flight before its request, then the request", async () => {
    const r = recorder();
    fetchMock.mockImplementation(async () => { r.at("generate"); return new Response("{}", { status: 200 }); });
    await new VertexExecutor().execute({ model: "model-a", body: { contents: [] }, stream: false, credentials: { apiKey: "raw-key" }, onUpstreamAttempt: r.hook });
    expect(r.calls).toEqual([0, "sent"]);
    expect(r.seen).toEqual([["generate", "sent"]]);
  });

  it("Zed reports nothing in flight while it fetches its catalog and tokens, including the token refresh retry", async () => {
    const r = recorder();
    let completions = 0;
    fetchMock.mockImplementation(async (url) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/llm_tokens")) { r.at("token"); return new Response(JSON.stringify({ token: "llm-token" }), { status: 200 }); }
      if (path.endsWith("/models")) { r.at("catalog"); return new Response(JSON.stringify({ models: [] }), { status: 200 }); }
      r.at("completion");
      // The first LLM token is refused, so Zed fetches a new one and retries.
      return ++completions === 1 ? new Response("expired", { status: 401 }) : new Response("", { status: 200 });
    });
    await new ZedExecutor().execute({
      model: "model-a",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { accessToken: "zed-access-recorder", providerSpecificData: { userId: "user-1", organizationId: "org-1" } },
      onUpstreamAttempt: r.hook,
    });
    expect(r.seen).toEqual([["token", 0], ["catalog", 0], ["catalog", 0], ["completion", "sent"], ["token", 0], ["completion", "sent"]]);
    expect(r.current).toBeGreaterThan(0);
  });

  it("Qoder reports nothing in flight while it looks up the model config, then its chat request", async () => {
    const r = recorder();
    qoderModelConfig.mockImplementationOnce(async () => { r.at("model-config"); return { key: "model-a", max_output_tokens: 100 }; });
    fetchMock.mockImplementation(async () => {
      r.at("chat");
      return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    await new QoderExecutor().execute({
      model: "model-a",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { accessToken: "device-token", providerSpecificData: { userId: "user-1", machineId: "machine-1" } },
      onUpstreamAttempt: r.hook,
    });
    expect(r.seen).toEqual([["model-config", 0], ["chat", "sent"]]);
    expect(r.current).toBeGreaterThan(0);
  });

  it("Codex reports nothing in flight while it downloads images or backs off from an overloaded stream", async () => {
    const r = recorder();
    const codex = new CodexExecutor();
    codex.config = { ...codex.config, retry: { ...codex.config?.retry, 503: { attempts: 1, delayMs: 10 } } };
    vi.spyOn(CodexExecutor.prototype, "prefetchImages").mockImplementation(async () => { r.at("images"); });
    let calls = 0;
    fetchMock.mockImplementation(async () => {
      r.at("responses");
      return ++calls === 1
        ? new Response("event: error\ndata: {\"type\":\"error\",\"error\":{\"code\":\"server_is_overloaded\"}}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } })
        : sse();
    });
    const result = await codex.execute({
      model: "gpt-5.3-codex",
      body: { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] },
      stream: true,
      credentials: { accessToken: "t", connectionId: "c" },
      onUpstreamAttempt: r.hook,
    });
    expect(result.response.ok).toBe(true);
    expect(r.seen).toEqual([["images", 0], ["responses", "sent"], ["responses", "sent"]]);
    // Nothing in flight between the overloaded stream and its retry.
    expect(r.calls).toEqual([0, "sent", 0, "sent"]);
  });

  it("GitHub reports its /v1/messages request for Claude models", async () => {
    const r = recorder();
    fetchMock.mockImplementation(async () => { r.at("messages"); return new Response("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }); });
    await new GithubExecutor().execute({
      model: "claude-test",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { accessToken: "t", copilotToken: "t" },
      onUpstreamAttempt: r.hook,
    });
    expect(r.seen).toEqual([["messages", "sent"]]);
  });

  it("GitHub reports its escalation to /responses as the attempt", async () => {
    const r = recorder();
    fetchMock.mockImplementation(async (url) => {
      if (String(url).endsWith("/responses")) {
        r.at("responses");
        return sse();
      }
      r.at("chat");
      return new Response("{\"error\":{\"message\":\"model is not accessible via the /chat/completions endpoint\"}}", { status: 400 });
    });
    const result = await new GithubExecutor().execute({
      model: "gpt-codex-test",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { accessToken: "t", copilotToken: "t" },
      onUpstreamAttempt: r.hook,
    });
    expect(result.response.ok).toBe(true);
    expect(r.seen).toEqual([["chat", "sent"], ["responses", "sent"]]);
    expect(r.current).toBeGreaterThan(0);
  });

  it("MiMo reports nothing in flight while it bootstraps its token, and the chat call once sent", async () => {
    mimo.resetJwtCache();
    const r = recorder();
    let chats = 0;
    fetchMock.mockImplementation(async (url) => {
      if (url === mimo.BOOTSTRAP_URL) {
        r.at("bootstrap");
        return new Response(JSON.stringify({ jwt: "header.payload.signature" }), { status: 200 });
      }
      r.at("chat");
      // The first JWT is refused, so it bootstraps again and retries.
      return ++chats === 1 ? new Response("expired", { status: 401 }) : sse();
    });
    const result = await new MimoFreeExecutor().execute({
      model: "mimo-test",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: {},
      onUpstreamAttempt: r.hook,
    });
    expect(result.response.ok).toBe(true);
    expect(r.seen).toEqual([["bootstrap", 0], ["chat", "sent"], ["bootstrap", 0], ["chat", "sent"]]);
    expect(r.current).toBeGreaterThan(0);
  });

  it("Kiro's repair retry, run while the body is read, reports no attempt of its own", async () => {
    const afterReturn = [];
    let returned = false;
    const hook = (ts) => { if (returned) afterReturn.push(ts); };
    // An empty first answer sends Kiro's integrity gate to a repair retry, refused here.
    fetchMock
      .mockResolvedValueOnce(new Response(new ReadableStream({ start(c) { c.close(); } }), { status: 200 }))
      .mockResolvedValue(new Response("unauthorized", { status: 401 }));
    const result = await new KiroExecutor().execute({
      model: "kiro-test",
      body: { systemPrompt: "base", conversationState: {} },
      stream: true,
      credentials: { accessToken: "t", providerSpecificData: { kiroToolCallRepair: true } },
      onUpstreamAttempt: hook,
    });
    returned = true;
    expect(await result.response.text()).toContain("kiro_integrity_retry_upstream_error");
    // The repair retry ran (through each of Kiro's base URLs), after execute() returned.
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(afterReturn).toEqual([]);
  });
});

describe("body wrappers pass a hang-up on", () => {
  const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });
  // An upstream body that sends `first`, then fails the way an aborted fetch does.
  const cutBody = (first) => new Response(new ReadableStream({
    start(controller) {
      if (first) controller.enqueue(new TextEncoder().encode(first));
      setTimeout(() => controller.error(abortError()), 20);
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });

  it("Windsurf doesn't turn it into an error event and [DONE]", async () => {
    const wrapped = new WindsurfExecutor().transformToSSE(cutBody(null), "model-a");
    await expect(wrapped.text()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("Qoder doesn't turn it into [DONE]", async () => {
    const frame = `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify({ choices: [{ index: 0, delta: { content: "partial" } }] }) })}\n`;
    const wrapped = await qoder.wrapQoderSSE(cutBody(frame), "model-a");
    await expect(wrapped.text()).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("every model id put in a URL path is escaped", () => {
  it("Hugging Face, fal.ai and Black Forest Labs images keep / and escape each part", () => {
    expect(target(hfImages.buildUrl("org/model one?x"))).toMatch(/\/org\/model%20one%3Fx$/);
    expect(target(falImages.buildUrl("vendor/model/variant#x"))).toMatch(/\/vendor\/model\/variant%23x$/);
    expect(target(bflImages.buildUrl("flux-test?x=1"))).toMatch(/\/flux-test%3Fx%3D1$/);
    for (const adapter of [hfImages, falImages, bflImages]) expect(() => adapter.buildUrl("org/%2e%2e/x")).toThrow(/Invalid model id/);
  });

  it("Gemini search keeps the model in one segment, and refuses a dot id with a 400", async () => {
    const urls = [];
    vi.stubGlobal("fetch", vi.fn(async (url) => { urls.push(url); return new Response("{}", { status: 200 }); }));
    await handleChatSearch({ provider: "gemini", query: "q", model: "x/../y?z", credentials: { apiKey: "k" } });
    expect(target(urls[0])).toMatch(/\/models\/x%2F\.\.%2Fy%3Fz:generateContent$/);
    const refused = await handleChatSearch({ provider: "gemini", query: "q", model: "..", credentials: { apiKey: "k" } });
    expect(refused.status).toBe(400);
    expect(urls).toHaveLength(1);
  });

  it("Gemini speech-to-text and text-to-speech keep the model in one segment", async () => {
    const urls = [];
    vi.stubGlobal("fetch", vi.fn(async (url) => { urls.push(url); return new Response(JSON.stringify({ candidates: [] }), { status: 200 }); }));
    const formData = new FormData();
    formData.append("file", new File([new Uint8Array([1, 2, 3])], "a.wav", { type: "audio/wav" }));
    await handleSttCore({ provider: "gemini", model: "x/../y", formData, credentials: { apiKey: "k" }, sttConfig: { format: "gemini-stt", baseUrl: "https://gemini.example/v1beta/models", authType: "key" } });
    expect(target(urls[0])).toBe("/v1beta/models/x%2F..%2Fy:generateContent");
    await geminiTts.synthesize("hi", "Kore", { apiKey: "k" }).catch(() => null);
    expect(target(urls[1])).toMatch(/\/models\/[^/]+:generateContent$/);
  });

  it("Hugging Face text-to-speech keeps / and escapes each part", async () => {
    const urls = [];
    vi.stubGlobal("fetch", vi.fn(async (url) => { urls.push(url); return new Response(new Uint8Array(2048), { status: 200 }); }));
    await ttsFormats["huggingface-tts"]({ baseUrl: "https://hf.example/models", apiKey: "k", text: "hi", modelId: "org/tts model" });
    expect(target(urls[0])).toBe("/models/org/tts%20model");
    await expect(ttsFormats["huggingface-tts"]({ baseUrl: "https://hf.example/models", apiKey: "k", text: "hi", modelId: "org/%2e%2e/x" })).rejects.toThrow(/Invalid HuggingFace model ID/);
    expect(urls).toHaveLength(1);
  });

  it("modelIdProblem refuses router lock names and applies the whole-id or per-part rule", () => {
    for (const reserved of ["__all", "websearch:gemini", "webfetch:ollama"]) expect(modelIdProblem(reserved)).toMatch(/reserved/);
    // Chat and embeddings escape a "/" in the id, so a self-hosted id with a leading slash is fine.
    expect(modelIdProblem("/models/served-model")).toBeNull();
    expect(modelIdProblem("x/../y")).toBeNull();
    for (const bad of ["", ".", "..", "%2e%2E"]) expect(modelIdProblem(bad)).toMatch(/Invalid model id/);
    // Images, speech and transcription keep "/", so every part is checked.
    for (const bad of ["/models/x", "org//x", "org/../x", "org/%2e/x"]) expect(modelIdProblem(bad, { segments: true })).toMatch(/Invalid model id/);
    expect(modelIdProblem("org/model", { segments: true })).toBeNull();
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
