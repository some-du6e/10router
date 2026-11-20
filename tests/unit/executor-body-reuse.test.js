// A resend of the same request to the same account (an in-place retry, the
// next base URL, the send after a token refresh) reuses the serialized body
// when nothing it is built from changed, instead of building and stringifying
// a 1-4 MB prompt again. Executors whose body depends on the URL, the token or
// per-send state still build it for every send.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...a) => fetchMock(...a) }));
// chatCore's logging and usage side effects.
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn(async () => new Proxy({}, {
    get: (target, key) => (key === "then" ? undefined : (target[key] ??= vi.fn())),
  })),
}));
vi.mock("../../open-sse/translator/concerns/prefetch.js", () => ({ prefetchRemoteImages: vi.fn(async () => 0) }));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}),
}));

const { BaseExecutor } = await import("../../open-sse/executors/base.js");
const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
const { KiroExecutor } = await import("../../open-sse/executors/kiro.js");
const { getExecutor } = await import("../../open-sse/executors/index.js");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

const A = "https://a.example.test/v1";
const B = "https://b.example.test/v1";
const C = "https://c.example.test/v1";
const MODEL = "test-model";
const COMPATIBLE = "openai-compatible-reuse-test";

const res = (status) => ({ status, ok: status >= 200 && status < 300, headers: { get: () => "" } });
const jsonRes = (status, payload) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
const networkError = async () => { throw new Error("ECONNRESET"); };
const sentUrls = () => fetchMock.mock.calls.map(([url]) => url);
const sentBodies = () => fetchMock.mock.calls.map(([, init]) => init.body);
const prompt = () => ({ model: MODEL, stream: true, messages: [{ role: "user", content: "x".repeat(64 * 1024) }] });

// How many times JSON.stringify was called on this very object: each call is
// another body-sized string.
function stringifyCounter() {
  const spy = vi.spyOn(JSON, "stringify");
  return (value) => spy.mock.calls.filter(([v]) => v === value).length;
}

beforeEach(() => fetchMock.mockReset());
afterEach(() => vi.restoreAllMocks());

describe("an executor whose body doesn't depend on the URL", () => {
  it("serializes once across in-place retries and base-URL fallbacks, and sends the same bytes each time", async () => {
    const ex = new BaseExecutor("test", { baseUrls: [A, B, C], retry: { 502: { attempts: 2, delayMs: 0 }, 503: { attempts: 2, delayMs: 0 } } });
    fetchMock
      .mockResolvedValueOnce(res(502)) // A: retried in place
      .mockResolvedValueOnce(res(503)) // A: retried in place
      .mockResolvedValueOnce(res(429)) // A → B
      .mockImplementationOnce(networkError) // B: retried in place
      .mockResolvedValueOnce(res(429)) // B → C
      .mockResolvedValueOnce(res(200));
    const stringified = stringifyCounter();
    const body = prompt();

    const out = await ex.execute({ model: MODEL, body, stream: true, credentials: { apiKey: "k" } });

    expect(out.response.status).toBe(200);
    expect(sentUrls()).toEqual([A, A, A, B, B, C]);
    expect(stringified(out.transformedBody)).toBe(1);
    const bodies = sentBodies();
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toBe(JSON.stringify(body));
  });

  it("Kiro: one body for every surface it falls back across, though each send gets its own headers", async () => {
    const ex = new KiroExecutor();
    ex.config = { ...ex.config, retry: { 502: { attempts: 1, delayMs: 0 } } };
    const urls = ex.getBaseUrls();
    expect(urls.length).toBeGreaterThanOrEqual(3);
    fetchMock
      .mockResolvedValueOnce(res(502)) // first surface: retried in place
      .mockResolvedValueOnce(res(429)) // → second
      .mockResolvedValueOnce(res(429)) // → third
      .mockResolvedValueOnce(res(400)); // last surface: returned as is
    const stringified = stringifyCounter();
    const body = { conversationState: { currentMessage: { userInputMessage: { content: "x".repeat(64 * 1024) } } } };

    const out = await ex.execute({ model: MODEL, body, stream: true, credentials: { accessToken: "t", providerSpecificData: {} } });

    expect(out.response.status).toBe(400);
    expect(sentUrls()).toEqual([urls[0], urls[0], urls[1], urls[2]]);
    const invocationIds = fetchMock.mock.calls.map(([, init]) => init.headers["Amz-Sdk-Invocation-Id"]);
    expect(new Set(invocationIds).size).toBe(4);
    expect(stringified(out.transformedBody)).toBe(1);
    const bodies = sentBodies();
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toBe(JSON.stringify(body));
  });
});

describe("an executor whose body depends on the URL or on per-send state", () => {
  it("builds the body again for every send when finalizeBody puts the URL in it", async () => {
    let builds = 0;
    class HostInBody extends BaseExecutor {
      buildHeaders(credentials, stream, url) {
        return { ...super.buildHeaders(credentials, stream), "X-Host": new URL(url).host };
      }
      finalizeBody(body, headers) {
        builds++;
        return { ...body, host: headers["X-Host"] };
      }
    }
    const ex = new HostInBody("test", { baseUrls: [A, B], retry: { 502: { attempts: 1, delayMs: 0 } } });
    fetchMock.mockResolvedValueOnce(res(502)).mockResolvedValueOnce(res(429)).mockResolvedValueOnce(res(200));
    const stringified = stringifyCounter();

    const out = await ex.execute({ model: MODEL, body: prompt(), stream: true, credentials: { apiKey: "k" } });

    expect(builds).toBe(3);
    expect(sentBodies().map((b) => JSON.parse(b).host)).toEqual(["a.example.test", "a.example.test", "b.example.test"]);
    expect(out.transformedBody.host).toBe("b.example.test");
    expect(stringified(out.transformedBody)).toBe(1);
  });

  it("keeps a per-send transformRequest per send, still run before the headers", async () => {
    const order = [];
    let n = 0;
    class PerSend extends BaseExecutor {
      transformRequest(model, body) {
        order.push("transform");
        return { ...body, send: ++n };
      }
      buildHeaders(credentials, stream) {
        order.push("headers");
        return super.buildHeaders(credentials, stream);
      }
    }
    const ex = new PerSend("test", { baseUrl: A, retry: { 503: { attempts: 2, delayMs: 0 } } });
    fetchMock.mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(200));

    await ex.execute({ model: MODEL, body: prompt(), stream: true, credentials: { apiKey: "k" } });

    expect(sentBodies().map((b) => JSON.parse(b).send)).toEqual([1, 2, 3]);
    expect(order).toEqual(["transform", "headers", "transform", "headers", "transform", "headers"]);
  });

  it("gets no reuse from DefaultExecutor once a subclass or instance overrides transformRequest", async () => {
    let subclassCalls = 0;
    class Sub extends DefaultExecutor {
      transformRequest(...args) {
        subclassCalls++;
        return super.transformRequest(...args);
      }
    }
    const sub = new Sub(COMPATIBLE);
    sub.config = { ...sub.config, retry: { 503: { attempts: 2, delayMs: 0 } } };
    const instance = new DefaultExecutor(COMPATIBLE);
    instance.config = { ...instance.config, retry: { 503: { attempts: 2, delayMs: 0 } } };
    const instanceTransform = vi.fn((model, body) => ({ ...body }));
    instance.transformRequest = instanceTransform;
    fetchMock.mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(200))
      .mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(200));
    const credentials = { apiKey: "k", providerSpecificData: { baseUrl: A } };

    await sub.execute({ model: MODEL, body: prompt(), stream: true, credentials });
    await instance.execute({ model: MODEL, body: prompt(), stream: true, credentials });

    expect(subclassCalls).toBe(3);
    expect(instanceTransform).toHaveBeenCalledTimes(3);
  });
});

describe("DefaultExecutor", () => {
  const creds = () => ({ accessToken: "old-access", providerSpecificData: { baseUrl: A } });
  const exec = () => {
    const ex = new DefaultExecutor(COMPATIBLE);
    ex.config = { ...ex.config, retry: { 502: { attempts: 2, delayMs: 0 }, 503: { attempts: 2, delayMs: 0 } } };
    return ex;
  };

  it("serializes once across its retries, and sends the bytes a fresh build of the request gives", async () => {
    const ex = exec();
    fetchMock.mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(502)).mockResolvedValueOnce(res(200));
    const stringified = stringifyCounter();
    // json_schema on a compatible node makes transformRequest build a new body.
    const body = { ...prompt(), response_format: { type: "json_schema", json_schema: { schema: { type: "object" } } } };
    const untouched = structuredClone(body);
    const transform = vi.spyOn(DefaultExecutor.prototype, "transformRequest");
    const finalize = vi.spyOn(DefaultExecutor.prototype, "finalizeBody");

    const out = await ex.execute({ model: MODEL, body, stream: true, credentials: creds() });

    expect(out.response.status).toBe(200);
    expect(transform).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(out.transformedBody).not.toBe(body);
    expect(stringified(out.transformedBody)).toBe(1);
    const bodies = sentBodies();
    expect(bodies).toHaveLength(3);
    expect(new Set(bodies).size).toBe(1);
    // Each send used to stringify a fresh copy: count the strings, not the objects.
    expect(JSON.stringify.mock.results.filter((r) => r.value === bodies[0])).toHaveLength(1);
    // The per-send pipeline, run on an untouched copy of the request.
    const c = creds();
    const headers = ex.buildHeaders(c, true, sentUrls()[0], MODEL);
    expect(bodies[0]).toBe(JSON.stringify(ex.finalizeBody(ex.transformRequest(MODEL, untouched, true, c), headers, c)));
  });

  it("reuses the body for the send after a token refresh: same bytes, new token", async () => {
    const ex = exec();
    fetchMock.mockResolvedValueOnce(res(401)).mockResolvedValueOnce(res(200));
    const stringified = stringifyCounter();
    const body = prompt();
    const credentials = creds();
    const bodyCache = {};

    const first = await ex.execute({ model: MODEL, body, stream: true, credentials, bodyCache });
    credentials.accessToken = "new-access"; // what chatCore's applyRefreshedCredentials does
    const second = await ex.execute({ model: MODEL, body, stream: true, credentials, bodyCache });

    expect(second.transformedBody).toBe(first.transformedBody);
    expect(stringified(first.transformedBody)).toBe(1);
    const [a, b] = fetchMock.mock.calls;
    expect(b[1].body).toBe(a[1].body);
    expect(a[1].headers.Authorization).toBe("Bearer old-access");
    expect(b[1].headers.Authorization).toBe("Bearer new-access");
  });

  it("builds again when the connection's settings or the body changed", async () => {
    const ex = exec();
    fetchMock.mockResolvedValue(res(200));
    const body = { ...prompt(), max_tokens: 100 };
    const credentials = creds();
    const bodyCache = {};

    await ex.execute({ model: MODEL, body, stream: true, credentials, bodyCache });
    credentials.providerSpecificData = { ...credentials.providerSpecificData, maxCompletionTokens: true };
    await ex.execute({ model: MODEL, body, stream: true, credentials, bodyCache });
    await ex.execute({ model: MODEL, body: { ...body, messages: [{ role: "user", content: "other" }] }, stream: true, credentials, bodyCache });

    const [first, second, third] = sentBodies().map((b) => JSON.parse(b));
    expect(first.max_tokens).toBe(100);
    expect(first.max_completion_tokens).toBeUndefined();
    expect(second.max_completion_tokens).toBe(100);
    expect(second.max_tokens).toBeUndefined();
    expect(third.messages[0].content).toBe("other");
  });
});

describe("Kiro's integrity gate", () => {
  it("keeps no hold on chatCore's cache: its mid-stream repair resend builds its own", async () => {
    const ex = new KiroExecutor();
    const gate = vi.spyOn(KiroExecutor.prototype, "attachIntegrityGate").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(res(200));
    const bodyCache = {};

    await ex.execute({ model: MODEL, body: { conversationState: {} }, stream: true, credentials: { accessToken: "t", providerSpecificData: {} }, bodyCache });

    expect(bodyCache.last).toBeTruthy();
    expect(gate).toHaveBeenCalledTimes(1);
    expect(gate.mock.calls[0][1].bodyCache).toBeNull();
  });
});

describe("chatCore", () => {
  const quietLog = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
  const chatReply = () => jsonRes(200, {
    id: "c1", object: "chat.completion", model: MODEL,
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
  const chat = (credentials, { stream = false, connectionId = "conn-1" } = {}) => {
    const body = { ...prompt(), stream };
    return handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider: COMPATIBLE, model: MODEL },
      credentials,
      clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: {} },
      connectionId,
      log: quietLog(),
    });
  };
  // Every bodyCache chatCore hands this executor.
  function cachesSeen(ex) {
    const seen = [];
    const execute = ex.execute;
    vi.spyOn(ex, "execute").mockImplementation(function (args) {
      seen.push(args.bodyCache);
      return execute.call(this, args);
    });
    return seen;
  }

  it("reuses the body the first send built for the send after a 401 token refresh", async () => {
    const ex = getExecutor(COMPATIBLE);
    vi.spyOn(ex, "refreshCredentials").mockResolvedValue({ accessToken: "new-access" });
    const transform = vi.spyOn(DefaultExecutor.prototype, "transformRequest");
    const finalize = vi.spyOn(DefaultExecutor.prototype, "finalizeBody");
    fetchMock.mockResolvedValueOnce(jsonRes(401, { error: { message: "expired" } })).mockResolvedValueOnce(chatReply());

    await chat({ accessToken: "old-access", refreshToken: "refresh", providerSpecificData: { baseUrl: A } });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [first, second] = fetchMock.mock.calls;
    expect(first[1].headers.Authorization).toBe("Bearer old-access");
    expect(second[1].headers.Authorization).toBe("Bearer new-access");
    expect(second[1].body).toBe(first[1].body);
    expect(transform).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it("empties the cache before the reply streams", async () => {
    const caches = cachesSeen(getExecutor(COMPATIBLE));
    const encoder = new TextEncoder();
    const chunk = (content, finish = null) => `data: ${JSON.stringify({
      id: "c1", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta: { content }, finish_reason: finish }],
    })}\n\n`;
    let pulls = 0;
    let heldWhileStreaming = "never read";
    // The first chunk is queued as the response is made; the second is pulled
    // only once something reads the stream, which chatCore does after its sends.
    const upstream = new ReadableStream({
      pull(controller) {
        pulls++;
        if (pulls === 1) return controller.enqueue(encoder.encode(chunk("hel")));
        heldWhileStreaming = caches[0]?.last;
        controller.enqueue(encoder.encode(`${chunk("lo", "stop")}data: [DONE]\n\n`));
        controller.close();
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(upstream, { status: 200, headers: { "content-type": "text/event-stream" } }));

    const result = await chat({ accessToken: "t", providerSpecificData: { baseUrl: A } }, { stream: true });
    await result.response.text();

    expect(caches).toHaveLength(1);
    expect(heldWhileStreaming).toBeNull();
  });

  it("gives each account attempt a cache of its own", async () => {
    const caches = cachesSeen(getExecutor(COMPATIBLE));
    const finalize = vi.spyOn(DefaultExecutor.prototype, "finalizeBody");
    fetchMock.mockResolvedValueOnce(chatReply()).mockResolvedValueOnce(chatReply());

    await chat({ accessToken: "account-a", providerSpecificData: { baseUrl: A } }, { connectionId: "conn-a" });
    await chat({ accessToken: "account-b", providerSpecificData: { baseUrl: A } }, { connectionId: "conn-b" });

    expect(caches).toHaveLength(2);
    expect(caches[0]).not.toBe(caches[1]);
    expect(finalize).toHaveBeenCalledTimes(2);
    expect(finalize.mock.results[1].value).not.toBe(finalize.mock.results[0].value);
    const [a, b] = fetchMock.mock.calls;
    expect(a[1].headers.Authorization).toBe("Bearer account-a");
    expect(b[1].headers.Authorization).toBe("Bearer account-b");
  });

  it("drops a rejected beta's field on the executor's beta retry, which shares the cache", async () => {
    const provider = "anthropic-compatible-reuse-test";
    const BETA = "context-management-2025-06-27";
    const CONTEXT_MANAGEMENT = { edits: [{ type: "clear_thinking_20251015", keep: "all" }] };
    const BETA_400 = `{"message":"Unexpected value(s) \`${BETA}\` for the \`anthropic-beta\` header. Please consult our documentation or try again without the header."}`;
    const ex = getExecutor(provider);
    ex.config = { ...ex.config, headers: { ...ex.config.headers, "anthropic-beta": BETA } };
    const caches = cachesSeen(ex);
    fetchMock
      .mockResolvedValueOnce(new Response(BETA_400, { status: 400, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(jsonRes(200, {
        id: "msg_1", type: "message", role: "assistant", model: MODEL,
        content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 },
      }));
    const body = {
      model: MODEL, max_tokens: 1024, stream: false, context_management: CONTEXT_MANAGEMENT,
      messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(64 * 1024) }] }],
    };

    await handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider, model: MODEL },
      credentials: { apiKey: "k", providerSpecificData: { baseUrl: "https://gateway.example.test/v1" } },
      // A Claude CLI client goes through untranslated, so context_management
      // reaches the executor (the OpenAI pivot drops it).
      clientRawRequest: { endpoint: "/v1/messages", body, headers: { "user-agent": "claude-cli/1.0.0 (external, cli)" } },
      connectionId: "conn-1",
      log: quietLog(),
    });

    expect(caches).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [first, second] = sentBodies().map((b) => JSON.parse(b));
    expect(first.context_management).toEqual(CONTEXT_MANAGEMENT);
    expect(second).not.toHaveProperty("context_management");
  });
});
