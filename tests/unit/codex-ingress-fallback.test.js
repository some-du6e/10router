import { describe, it, expect, vi, beforeEach } from "vitest";

const aliases = vi.hoisted(() => ({ value: {} }));
const combos = vi.hoisted(() => ({ value: {} }));
const seen = vi.hoisted(() => ({ body: null }));

vi.mock("@/lib/localDb", () => ({
  getModelAliases: async () => aliases.value,
  getComboByName: async (name) => combos.value[name] || null,
}));

vi.mock("@/sse/services/codexPooledUsage", () => ({
  getPooledCodexRateLimitHeaders: () => ({}),
}));

vi.mock("../../src/app/api/v1/responses/route.js", () => ({
  OPTIONS: () => new Response(null),
  POST: async (request) => {
    // The real handler rejects a non-JSON body itself; here it only has to not
    // throw, so the pass-through case can assert the fallback stayed out of it.
    try {
      seen.body = await request.json();
    } catch {
      seen.body = null;
    }
    return new Response("{}", { status: 200 });
  },
}));

const { POST } = await import("@/app/api/v1/codex/responses/route.js");

const post = (body) => POST(new Request("http://local/backend-api/codex/responses", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
}));

describe("Codex ingress model fallback", () => {
  beforeEach(() => {
    aliases.value = {};
    combos.value = {};
    seen.body = null;
  });

  it("sends an unknown bare model to Codex rather than OpenAI", async () => {
    await post({ model: "gpt-5.6-luna", input: [] });
    expect(seen.body.model).toBe("cx/gpt-5.6-luna");
  });

  it("leaves an explicit provider prefix alone", async () => {
    await post({ model: "anthropic/claude-sonnet-4", input: [] });
    expect(seen.body.model).toBe("anthropic/claude-sonnet-4");
  });

  it("leaves a user's alias alone", async () => {
    aliases.value = { "gpt-5.6-luna": "anthropic/claude-haiku" };
    await post({ model: "gpt-5.6-luna", input: [] });
    expect(seen.body.model).toBe("gpt-5.6-luna");
  });

  it("leaves a combo alone", async () => {
    combos.value = { "my-combo": { name: "my-combo" } };
    await post({ model: "my-combo", input: [] });
    expect(seen.body.model).toBe("my-combo");
  });

  it("passes a bodyless or non-JSON request straight through", async () => {
    const response = await POST(new Request("http://local/backend-api/codex/responses", {
      method: "POST",
      body: "not json",
    }));
    expect(response.status).toBe(200);
  });
});
