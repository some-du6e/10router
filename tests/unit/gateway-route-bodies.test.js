import { beforeEach, describe, expect, it, vi } from "vitest";

const { handleChatMock } = vi.hoisted(() => ({ handleChatMock: vi.fn() }));
vi.mock("@/sse/handlers/chat.js", () => ({ handleChat: handleChatMock }));
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireApiKey: false }),
  getModelAliases: async () => ({}),
  getComboByName: async () => null,
}));
vi.mock("@/sse/services/autoCombo.js", () => ({
  resolveAutoCombo: async () => null,
  getAutoComboCatalogMatches: () => [],
  isPlainBareId: async (model) => !model.includes("/"),
}));

const post = (path, raw) => new Request(`http://localhost${path}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: raw,
});
const geminiPath = "openai/gpt-4o:generateContent";
const geminiCtx = () => ({ params: Promise.resolve({ path: ["openai", "gpt-4o:generateContent"] }) });

const routes = [
  ["/v1/responses/compact", () => import("../../src/app/api/v1/responses/compact/route.js"), "/v1/responses/compact", undefined],
  ["/v1beta/models/*", () => import("../../src/app/api/v1beta/models/[...path]/route.js"), `/v1beta/models/${geminiPath}`, geminiCtx],
  ["/v1/messages/count_tokens", () => import("../../src/app/api/v1/messages/count_tokens/route.js"), "/v1/messages/count_tokens", undefined],
];

beforeEach(() => {
  handleChatMock.mockReset();
  handleChatMock.mockImplementation(async () => Response.json({ ok: true }));
});

describe.each(routes)("%s body", (_name, load, path, ctx) => {
  it.each(["null", "[]", '"text"', "42", "true"])("answers non-object JSON %s with a 400", async (raw) => {
    const { POST } = await load();
    const response = await POST(post(path, raw), ctx?.());
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe("Request body must be an object");
    expect(handleChatMock).not.toHaveBeenCalled();
  });

  it("answers malformed JSON with a 400", async () => {
    const { POST } = await load();
    const response = await POST(post(path, "{"), ctx?.());
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe("Invalid JSON body");
    expect(handleChatMock).not.toHaveBeenCalled();
  });
});

describe("/v1/responses/compact", () => {
  it("still forwards an object body marked as a compaction", async () => {
    const { POST } = await import("../../src/app/api/v1/responses/compact/route.js");
    await POST(post("/v1/responses/compact", JSON.stringify({ model: "openai/gpt-4o", input: "hi" })));
    expect(JSON.parse(await handleChatMock.mock.calls[0][0].text())).toEqual({ model: "openai/gpt-4o", input: "hi", _compact: true });
  });
});

describe("Codex compact ingress", () => {
  it.each(["null", "[]"])("forwards %s as { _compact: true }", async (raw) => {
    const { POST } = await import("../../src/app/api/v1/codex/responses/compact/route.js");
    await POST(post("/backend-api/codex/responses/compact", raw));
    expect(JSON.parse(await handleChatMock.mock.calls[0][0].text())).toEqual({ _compact: true });
  });
});
