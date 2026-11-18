// Early headers are opt-in per route: only the routes whose Response goes to the
// client as is turn them on. Wrappers that reshape the Response (Ollama, Gemini)
// or call handleChat for a side job (compact) need its real status. A route that
// rebuilds the Request keeps the client's signal, so a hang-up still reaches routing.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handleChatMock } = vi.hoisted(() => ({ handleChatMock: vi.fn() }));
vi.mock("@/sse/handlers/chat.js", () => ({ handleChat: handleChatMock }));
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireApiKey: false }),
  getModelAliases: async () => ({}),
  getComboByName: async () => null,
}));
vi.mock("@/sse/services/autoCombo.js", () => ({ resolveAutoCombo: async () => null, getAutoComboProviders: () => [] }));
vi.mock("@/sse/services/codexPooledUsage", () => ({ getPooledCodexRateLimitHeaders: () => ({}) }));

const sse = () => new Response("data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
const post = (path, body, signal) => new Request(`http://localhost${path}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
  signal,
});
const chatBody = { model: "openai/gpt-4o", stream: true, messages: [{ role: "user", content: "hi" }] };
const earlyOpt = () => handleChatMock.mock.calls[0][2];

beforeEach(() => {
  handleChatMock.mockReset();
  handleChatMock.mockImplementation(async () => sse());
});

describe("early headers route opt-in", () => {
  it.each([
    ["/v1/messages", () => import("../../src/app/api/v1/messages/route.js"), { ...chatBody, max_tokens: 10 }],
    ["/v1/chat/completions", () => import("../../src/app/api/v1/chat/completions/route.js"), chatBody],
    ["/v1/responses", () => import("../../src/app/api/v1/responses/route.js"), { model: "openai/gpt-4o", stream: true, input: "hi" }],
  ])("%s turns them on", async (path, load, body) => {
    const { POST } = await load();
    await POST(post(path, body));
    expect(earlyOpt()).toEqual({ earlyHeaders: true });
  });

  it("/v1/responses/compact does not", async () => {
    const { POST } = await import("../../src/app/api/v1/responses/compact/route.js");
    await POST(post("/v1/responses/compact", { model: "openai/gpt-4o", input: "hi" }));
    expect(handleChatMock).toHaveBeenCalled();
    expect(earlyOpt()?.earlyHeaders).toBeFalsy();
  });

  it("the Ollama route does not", async () => {
    const { POST } = await import("../../src/app/api/v1/api/chat/route.js");
    await POST(post("/v1/api/chat", { model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] }));
    expect(handleChatMock).toHaveBeenCalled();
    expect(earlyOpt()?.earlyHeaders).toBeFalsy();
  });

  it("the Gemini v1beta route does not", async () => {
    const { POST } = await import("../../src/app/api/v1beta/models/[...path]/route.js");
    const body = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };
    await POST(post("/v1beta/models/openai/gpt-4o:streamGenerateContent", body), { params: Promise.resolve({ path: ["openai", "gpt-4o:streamGenerateContent"] }) });
    expect(handleChatMock).toHaveBeenCalled();
    expect(earlyOpt()?.earlyHeaders).toBeFalsy();
  });
});

describe("rebuilt requests keep the client's signal", () => {
  const geminiBody = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };
  it.each([
    ["the Codex ingress (bare model rewritten to cx/)", () => import("../../src/app/api/v1/codex/responses/route.js"), "/backend-api/codex/responses", { model: "gpt-5", stream: true, input: "hi" }, undefined],
    ["/v1/responses/compact", () => import("../../src/app/api/v1/responses/compact/route.js"), "/v1/responses/compact", { model: "openai/gpt-4o", input: "hi" }, undefined],
    ["the Gemini v1beta route", () => import("../../src/app/api/v1beta/models/[...path]/route.js"), "/v1beta/models/openai/gpt-4o:streamGenerateContent", geminiBody, { params: Promise.resolve({ path: ["openai", "gpt-4o:streamGenerateContent"] }) }],
  ])("%s", async (_name, load, path, body, ctx) => {
    const { POST } = await load();
    const client = new AbortController();
    const original = post(path, body, client.signal);
    await POST(original, ctx);
    const forwarded = handleChatMock.mock.calls[0][0];
    expect(forwarded).not.toBe(original);
    expect(forwarded.signal.aborted).toBe(false);
    client.abort();
    expect(forwarded.signal.aborted).toBe(true);
  });

  it("the Codex ingress still turns early headers on", async () => {
    const { POST } = await import("../../src/app/api/v1/codex/responses/route.js");
    await POST(post("/backend-api/codex/responses", { model: "gpt-5", stream: true, input: "hi" }));
    expect(handleChatMock.mock.calls[0][0].url).toContain("/backend-api/codex/responses");
    expect(JSON.parse(await handleChatMock.mock.calls[0][0].text()).model).toBe("cx/gpt-5");
    expect(earlyOpt()).toEqual({ earlyHeaders: true });
  });
});
