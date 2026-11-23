// A request whose account answers 429 goes to the next account with the same
// body. The account loop hands every attempt of a pass one cache (chatCore's
// attemptCache): an attempt whose body would go out as the bytes the last one
// sent sends those bytes again, without serializing or encoding the prompt
// again, and its request detail rows get the same client request and sent
// body objects, so they are capped once. Each row still shows what a build of
// its own attempt would show, and a body that comes out different is built.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...a) => fetchMock(...a) }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn(async () => new Proxy({}, {
    get: (target, key) => (key === "then" ? undefined : (target[key] ??= vi.fn())),
  })),
}));
vi.mock("../../open-sse/translator/concerns/prefetch.js", () => ({ prefetchRemoteImages: vi.fn(async () => 0) }));
const rows = [];
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async (detail) => { rows.push(detail); }), saveRequestUsage: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { __test__: repo } = await import("../../src/lib/db/repos/requestDetailsRepo.js");

const MODEL = "test-model";
const PROVIDER = "openai-compatible-attempt-reuse-test";
const BASE = "https://gateway.example.test/v1";
const LIMITED = () => new Response(JSON.stringify({ error: { message: "Rate limit reached", type: "rate_limit_error" } }), { status: 429, headers: { "content-type": "application/json" } });
const REPLY = () => new Response(JSON.stringify({
  id: "c1", object: "chat.completion", model: MODEL,
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
}), { status: 200, headers: { "content-type": "application/json" } });

// A Claude client's request, translated for an OpenAI-compatible upstream on every attempt.
const clientBody = () => ({
  model: `${PROVIDER}/${MODEL}`,
  max_tokens: 1024,
  stream: false,
  thinking: { type: "enabled", budget_tokens: 2048 },
  system: [{ type: "text", text: "Be brief." }],
  messages: Array.from({ length: 40 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: [{ type: "text", text: `turn ${i}: ${"é\"\n😀 ".repeat(800)}` }],
  })),
});
const LARGE = 64 * 1024;

const account = (name, psd = {}) => ({ apiKey: `sk-${name}`, connectionId: name, providerSpecificData: { baseUrl: BASE, ...psd } });
const quietLog = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

// One pass of the account loop: each account in turn, as src/sse/handlers/chat.ts calls chatCore.
async function pass(accounts, { shared = true } = {}) {
  const body = clientBody();
  const attemptCache = shared ? {} : undefined;
  const results = [];
  for (const credentials of accounts) {
    const result = await handleChatCore({
      body: { ...body, model: `${PROVIDER}/${MODEL}` },
      modelInfo: { provider: PROVIDER, model: MODEL },
      credentials,
      clientRawRequest: { endpoint: "/v1/messages", body, headers: {} },
      connectionId: credentials.connectionId,
      log: quietLog(),
      ...(attemptCache && { attemptCache }),
    });
    results.push(result);
    if (result.success) break;
  }
  return { results, attemptCache };
}

// Every row's payloads as the dashboard stores them: capped, then JSON.
const stored = (list) => list.map((row) => JSON.stringify({ request: repo.truncateField(row.request, 5 * 1024), providerRequest: repo.truncateField(row.providerRequest, 5 * 1024) }));
const sentText = () => fetchMock.mock.calls.map(([, init]) => Buffer.from(init.body).toString("utf8"));

beforeEach(() => {
  fetchMock.mockReset();
  rows.length = 0;
});
afterEach(() => vi.restoreAllMocks());

describe("an account fallback", () => {
  it("sends the next account the bytes the first one got, serializing the prompt once", async () => {
    fetchMock.mockResolvedValueOnce(LIMITED()).mockResolvedValueOnce(LIMITED()).mockResolvedValueOnce(REPLY());
    const real = JSON.stringify;
    let large = 0;
    vi.spyOn(JSON, "stringify").mockImplementation(function (value, ...rest) {
      const out = real.call(JSON, value, ...rest);
      if (typeof out === "string" && out.length > LARGE) large++;
      return out;
    });

    const { results } = await pass([account("a"), account("b"), account("c")]);

    vi.restoreAllMocks();
    expect(results.map((r) => r.success)).toEqual([false, false, true]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const bodies = fetchMock.mock.calls.map(([, init]) => init.body);
    expect(bodies[1]).toBe(bodies[0]);
    expect(bodies[2]).toBe(bodies[0]);
    expect(large).toBe(1);
    // Each account still gets its own key.
    expect(fetchMock.mock.calls.map(([, init]) => init.headers.Authorization)).toEqual(["Bearer sk-a", "Bearer sk-b", "Bearer sk-c"]);
  });

  it("sends each account what a build of its own attempt sends", async () => {
    fetchMock.mockResolvedValueOnce(LIMITED()).mockResolvedValueOnce(LIMITED()).mockResolvedValueOnce(REPLY());
    await pass([account("a"), account("b"), account("c")]);
    const reused = sentText();
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(LIMITED()).mockResolvedValueOnce(LIMITED()).mockResolvedValueOnce(REPLY());
    await pass([account("a"), account("b"), account("c")], { shared: false });
    expect(reused).toEqual(sentText());
  });

  it("hands request details the same client request and sent body for every attempt, so each is capped once", async () => {
    fetchMock.mockResolvedValueOnce(LIMITED()).mockResolvedValueOnce(LIMITED()).mockResolvedValueOnce(REPLY());

    await pass([account("a"), account("b"), account("c")]);

    // Two error rows and the reply's row.
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.status)).toEqual(["error", "error", "success"]);
    expect(rows[1].request).toBe(rows[0].request);
    expect(rows[2].request).toBe(rows[0].request);
    expect(rows[1].providerRequest).toBe(rows[0].providerRequest);
    expect(rows[2].providerRequest).toBe(rows[0].providerRequest);
    // truncateField's cache keys on the object, so the capped records are shared too.
    expect(repo.truncateField(rows[2].request, 5 * 1024)).toBe(repo.truncateField(rows[0].request, 5 * 1024));
  });

  it("stores every row as it is stored when each attempt builds its own body", async () => {
    fetchMock.mockResolvedValueOnce(LIMITED()).mockResolvedValueOnce(LIMITED()).mockResolvedValueOnce(REPLY());
    await pass([account("a"), account("b"), account("c")]);
    const reused = stored(rows);
    rows.length = 0;
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(LIMITED()).mockResolvedValueOnce(LIMITED()).mockResolvedValueOnce(REPLY());
    await pass([account("a"), account("b"), account("c")], { shared: false });
    expect(stored(rows)).toEqual(reused);
    expect(JSON.parse(reused[0]).providerRequest._truncated).toBe(true);
  });

  it("builds and sends a body of its own when the next account's settings change it, and its row shows that body", async () => {
    fetchMock.mockResolvedValueOnce(LIMITED()).mockResolvedValueOnce(REPLY());

    // This account's endpoint wants max_completion_tokens in place of max_tokens.
    await pass([account("a"), account("b", { maxCompletionTokens: true })]);

    const [first, second] = sentText().map((text) => JSON.parse(text));
    expect(first.max_tokens).toBe(1024);
    expect(second.max_tokens).toBeUndefined();
    expect(second.max_completion_tokens).toBe(1024);
    const bodies = fetchMock.mock.calls.map(([, init]) => init.body);
    expect(bodies[1]).not.toBe(bodies[0]);
    expect(rows[1].providerRequest).not.toBe(rows[0].providerRequest);
    expect(rows[0].providerRequest.max_tokens).toBe(1024);
    expect(rows[1].providerRequest.max_completion_tokens).toBe(1024);
    // The client's request is the same for both.
    expect(rows[1].request).toBe(rows[0].request);
  });

  it("lets go of the sent bytes and the client request once a reply starts", async () => {
    fetchMock.mockResolvedValueOnce(LIMITED()).mockResolvedValueOnce(REPLY());
    const { attemptCache, results } = await pass([account("a"), account("b")]);
    expect(results.at(-1).success).toBe(true);
    expect(attemptCache.last).toBeNull();
    expect(attemptCache.clientRequest).toBeNull();
  });

  it("keeps them for the next account after a failed attempt", async () => {
    fetchMock.mockResolvedValueOnce(LIMITED());
    const { attemptCache } = await pass([account("a")]);
    expect(Buffer.isBuffer(attemptCache.last?.bytes)).toBe(true);
    expect(attemptCache.clientRequest).toBe(rows[0].request);
  });
});
