import { describe, it, expect, vi } from "vitest";

// The Translator preview (step 3) must show the body the executor really sends,
// so it runs finalizeBody after transformRequest, like BaseExecutor.execute.
vi.mock("@/lib/localDb.js", () => ({
  getProviderConnections: async () => [{ isActive: true, providerSpecificData: {} }],
}));
vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    buildUrl: () => "https://relay.example.net/v1/messages",
    buildHeaders: () => ({ "anthropic-beta": "x-1" }),
    transformRequest: (_m, body) => ({ ...body, safeguards: [{ type: "dangerous_tool_use" }] }),
    finalizeBody: (body, headers) => {
      expect(headers).toEqual({ "anthropic-beta": "x-1" });
      const { safeguards, ...rest } = body;
      return rest;
    },
  }),
}));

const { POST } = await import("@/app/api/translator/translate/route.js");

describe("translator preview step 3", () => {
  it("returns the finalized body", async () => {
    const req = new Request("http://x/api/translator/translate", {
      method: "POST",
      body: JSON.stringify({ step: 3, body: { provider: "anthropic", model: "claude-opus-5-5", body: { model: "m", messages: [{ role: "user", content: "hi" }] } } }),
    });
    const res = await POST(req);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.result.body).not.toHaveProperty("safeguards");
    expect(json.result.body.messages).toBeDefined();
  });
});
