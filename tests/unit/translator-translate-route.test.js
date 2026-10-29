// The dashboard Translator preview (step 3) must show the body a real send
// would make, including the edits made once headers are known.
import { describe, it, expect, vi } from "vitest";

const SAFEGUARDS = [{ type: "dangerous_tool_use", classifier_context: { v: 1 } }];

vi.mock("next/server", () => ({
  NextResponse: { json: (body, init) => ({ status: init?.status || 200, body }) },
}));
vi.mock("@/lib/localDb.js", () => ({
  getProviderConnections: async () => [{ apiKey: "k", isActive: true }],
}));
vi.mock("open-sse/translator/index.js", async (importOriginal) => ({
  ...(await importOriginal()),
  translateRequest: (_from, _to, model) => ({
    model, max_tokens: 1024, messages: [{ role: "user", content: "hi" }], safeguards: SAFEGUARDS,
  }),
}));

const { POST } = await import("../../src/app/api/translator/translate/route.js");

const step3 = (provider) => POST({
  json: async () => ({ step: 3, body: { provider, model: "claude-opus-5-5", body: { messages: [{ role: "user", content: "hi" }] } } }),
});

describe("Translator preview, step 3", () => {
  it("drops safeguards for the anthropic provider, whose headers lack its beta", async () => {
    const { status, body } = await step3("anthropic");
    expect(status).toBe(200);
    expect(body.result.url).toBe("https://api.anthropic.com/v1/messages");
    expect(body.result.body).not.toHaveProperty("safeguards");
    expect(body.result.body.messages).toHaveLength(1);
  });
});
