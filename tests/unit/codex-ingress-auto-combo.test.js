import { describe, it, expect, vi, beforeEach } from "vitest";

// The Codex door through the real /v1/responses route and the real account
// loop in handleChat, with the catalog and provider layer stubbed: a model
// Codex and another provider both serve tries Codex, then falls back.
const state = vi.hoisted(() => ({ combo: null, catalog: [], tried: [], served: new Set(), results: {} }));

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireApiKey: false }),
  getModelAliases: async () => ({}),
  getComboByName: async () => null,
}));
vi.mock("@/sse/services/codexPooledUsage", () => ({ getPooledCodexRateLimitHeaders: () => ({}) }));
vi.mock("@/sse/services/autoCombo.js", async (importOriginal) => ({
  ...(await importOriginal()),
  // handleChat must route the list the door resolved, never resolve its own.
  resolveAutoCombo: async (_m, _a, opts) => (opts?.preferProvider === "codex" ? state.combo : null),
  getAutoComboCatalogMatches: () => state.catalog,
  billingPolicyApplies: async () => false,
}));
vi.mock("@/sse/services/auth.js", async (importOriginal) => ({
  ...(await importOriginal()),
  extractApiKey: () => null,
  // One account per provider, unavailable once it has been tried.
  getProviderCredentials: async (provider) => {
    if (state.served.has(provider)) return null;
    state.served.add(provider);
    return { connectionId: `${provider}-1`, connectionName: provider, accessToken: "t" };
  },
  markAccountUnavailable: async () => ({ shouldFallback: true, cooldownMs: 1000 }),
  clearAccountError: async () => {},
}));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: async (m) => (m.includes("/") ? { provider: m.split("/")[0], model: m.split("/")[1] } : { provider: "openai", model: m }),
  getComboModels: async () => null,
  comboLookupName: (name) => name,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_p, c) => c,
  updateProviderCredentials: async () => {},
}));
vi.mock("open-sse/handlers/chatCore.js", async (importOriginal) => ({
  ...(await importOriginal()),
  handleChatCore: async ({ modelInfo, body }) => {
    state.tried.push({ model: `${modelInfo.provider}/${modelInfo.model}`, compact: body._compact === true });
    return state.results[modelInfo.provider] || { success: true, response: new Response('{"ok":true}', { headers: { "Content-Type": "application/json" } }) };
  },
}));

const { POST } = await import("@/app/api/v1/codex/responses/route.js");
const { POST: compactPOST } = await import("@/app/api/v1/codex/responses/compact/route.js");

const post = (handler, model) => handler(new Request("http://local/backend-api/codex/responses", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model, input: [{ role: "user", content: "hi" }] }),
}));

describe("Codex door auto combo, end to end", () => {
  beforeEach(() => {
    state.combo = ["cx/gpt-6-astra", "snow/openai-gpt-6-astra"];
    state.catalog = [{ id: "cx/gpt-6-astra", provider: "codex" }, { id: "snow/openai-gpt-6-astra", provider: "snow" }];
    state.tried = [];
    state.served = new Set();
    state.results = {};
  });

  it("falls back to the other provider when the Codex account fails", async () => {
    state.results.cx = { success: false, status: 401, error: "Encountered invalidated oauth token" };
    const res = await post(POST, "gpt-6-astra");
    expect(res.status).toBe(200);
    expect(state.tried.map((t) => t.model)).toEqual(["cx/gpt-6-astra", "snow/openai-gpt-6-astra"]);
  });

  it("stays on Codex when it answers", async () => {
    await post(POST, "gpt-6-astra");
    expect(state.tried.map((t) => t.model)).toEqual(["cx/gpt-6-astra"]);
  });

  it("keeps compactions on Codex, still marked as compactions", async () => {
    state.results.cx = { success: false, status: 401, error: "Encountered invalidated oauth token" };
    await post(compactPOST, "gpt-6-astra");
    expect(state.tried).toEqual([{ model: "cx/gpt-6-astra", compact: true }]);
  });
});
