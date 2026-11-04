// Early headers are opt-in per route: only the routes whose Response goes to the
// client as is turn them on. Wrappers that reshape the Response (Ollama, Gemini)
// or call handleChat for a side job (compact) need its real status.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handleChatMock } = vi.hoisted(() => ({ handleChatMock: vi.fn() }));
vi.mock("@/sse/handlers/chat.js", () => ({ handleChat: handleChatMock }));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({ requireApiKey: false }) }));

const sse = () => new Response("data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
const post = (path, body) => new Request(`http://localhost${path}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
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
