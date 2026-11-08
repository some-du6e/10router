// Per-request state that must not leak between requests or clients on the
// upstream path: Codex's compact endpoint, model ids placed in URL paths, and
// Kiro's session replay.
import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...a) => fetchMock(...a) }));

const { getExecutor } = await import("../../open-sse/executors/index.js");
const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
const { VertexExecutor } = await import("../../open-sse/executors/vertex.js");
const { AzureExecutor } = await import("../../open-sse/executors/azure.js");
const { clearKiroSessionReplayStore } = await import("../../open-sse/utils/kiroSessionReplay.js");
const { clearSessionStore } = await import("../../open-sse/utils/sessionManager.js");
const { openaiToKiroRequest } = await import("../../open-sse/translator/request/openai-to-kiro.js");

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
  const target = (url) => { const u = new URL(url); return u.pathname; };

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
});
