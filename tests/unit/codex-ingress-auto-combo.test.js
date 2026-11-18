import { describe, it, expect, vi, beforeEach } from "vitest";

// The Codex ingress through the real Codex routes and the real account loop in
// handleChat, with the catalog and provider layer stubbed: a model Codex and
// another provider both serve tries Codex, then falls back.
const state = vi.hoisted(() => ({
  combo: null, catalog: [], resolved: 0, tried: [], served: new Set(), results: {}, limited: {},
  settings: {}, hold: false, held: [], apiKeyOnly: new Set(),
  // codexId: cx/ resolves to the real provider id "codex" (session affinity needs it).
  // keyAllows: models the client key may use, null = no allowlist.
  // runHeldAttempt: the hold re-runs the request once instead of answering at once.
  codexId: false, keyAllows: null, runHeldAttempt: false,
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireApiKey: false, ...state.settings }),
  getModelAliases: async () => ({}),
  getComboByName: async () => null,
}));
vi.mock("@/sse/services/codexPooledUsage", () => ({ getPooledCodexRateLimitHeaders: () => ({}) }));
vi.mock("@/sse/services/autoCombo.js", async (importOriginal) => ({
  ...(await importOriginal()),
  // Only the ingress's own call gets the list: handleChat must route the list
  // the ingress resolved, never resolve its own.
  resolveAutoCombo: async () => (state.resolved++ === 0 ? state.combo : null),
  getAutoComboCatalogMatches: () => state.catalog,
  billingPolicyApplies: async () => false,
}));
vi.mock("@/sse/services/auth.js", async (importOriginal) => ({
  ...(await importOriginal()),
  extractApiKey: () => null,
  // One account per provider. Once tried it is gone, or rate-limited when the
  // test says so.
  // A provider in apiKeyOnly has just a Codex API-key account, which an auto
  // combo's billing filter (pay per token blocked by default) would skip.
  getProviderCredentials: async (provider, _exclude, _model, options) => {
    if (state.apiKeyOnly.has(provider) && options?.connectionFilter && !options.connectionFilter({ provider: "codex", authType: "apikey" })) return null;
    if (state.served.has(provider)) return state.limited[provider] || null;
    state.served.add(provider);
    return { connectionId: `${provider}-1`, connectionName: provider, accessToken: "t" };
  },
  markAccountUnavailable: async () => ({ shouldFallback: true, cooldownMs: 1000 }),
  clearAccountError: async () => {},
}));
vi.mock("@/sse/services/keyLimits.js", async (importOriginal) => {
  const actual = await importOriginal();
  const allows = (model) => state.keyAllows === null || state.keyAllows.includes(model);
  return {
    ...actual,
    requestKeyAllowsModel: async (_request, model) => allows(model),
    // What the hold checks before each re-run.
    apiKeyLimitDenial: async (_key, { model }) => (allows(model) ? null : {
      status: 403, message: "model not allowed",
      response: new Response('{"error":{"code":"model_not_allowed"}}', { status: 403, headers: { "Content-Type": "application/json" } }),
    }),
  };
});
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: async (m) => {
    if (!m.includes("/")) return { provider: "openai", model: m };
    const [prefix, model] = m.split("/");
    return { provider: prefix === "cx" && state.codexId ? "codex" : prefix, model };
  },
  getComboModels: async () => null,
  comboLookupName: (name) => name,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_p, c) => c,
  updateProviderCredentials: async () => {},
}));
vi.mock("@/sse/services/limitHoldConfig.js", () => ({
  resolveLimitHold: async () => ({ enabled: state.hold, onPinned: !!state.settings.limitHoldOnPinned }),
}));
vi.mock("open-sse/utils/limitHold.js", async (importOriginal) => ({
  ...(await importOriginal()),
  // The hold itself: record what it would wait for, then answer at once, or
  // re-run the request once and answer with that.
  awaitLimitClear: async ({ retryAtMs, attempt }) => {
    state.held.push(retryAtMs);
    if (state.runHeldAttempt) return { response: (await attempt()).response };
    return { response: new Response('{"held":true}', { headers: { "Content-Type": "application/json" } }) };
  },
}));
vi.mock("open-sse/handlers/chatCore.js", async (importOriginal) => ({
  ...(await importOriginal()),
  handleChatCore: async ({ modelInfo, body }) => {
    state.tried.push({ model: `${modelInfo.provider}/${modelInfo.model}`, compact: body._compact === true });
    // Results are factories: a Response body can be read only once.
    return state.results[modelInfo.provider]?.() || { success: true, response: new Response('{"ok":true}', { headers: { "Content-Type": "application/json" } }) };
  },
}));

const { POST } = await import("@/app/api/v1/codex/responses/route.js");
const { POST: compactPOST } = await import("@/app/api/v1/codex/responses/compact/route.js");
const { affinityKeyFor, bindAffinity } = await import("open-sse/services/sessionAffinity.js");

const post = (handler, model, input = [{ role: "user", content: "hi" }], extra = {}, headers = {}) => handler(new Request("http://local/backend-api/codex/responses", {
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify({ model, input, ...extra }),
}));

const tried = () => state.tried.map((t) => t.model);
const fail = (status, error) => ({
  success: false, status, error,
  response: new Response(JSON.stringify({ error: { message: error } }), { status, headers: { "Content-Type": "application/json" } }),
});
const AUTH_FAILED = () => fail(401, "token expired");
const OTHER_REFUSED = () => fail(400, "other provider refused");
const CODEX_RESET = new Date(Date.now() + 60_000).toISOString();
const CODEX_LIMIT_ERROR = "codex usage limit reached";

beforeEach(() => {
  state.combo = ["cx/gpt-x", "ctso/openai-gpt-x"];
  state.catalog = [{ id: "cx/gpt-x", provider: "codex" }, { id: "ctso/openai-gpt-x", provider: "ctso" }];
  state.resolved = 0;
  state.tried = [];
  state.served = new Set();
  state.results = {};
  state.limited = {};
  state.settings = {};
  state.hold = false;
  state.held = [];
  state.apiKeyOnly = new Set();
  state.codexId = false;
  state.keyAllows = null;
  state.runHeldAttempt = false;
});

describe("Codex ingress auto combo, end to end", () => {
  it("falls back to the other provider when the Codex account fails", async () => {
    state.results.cx = AUTH_FAILED;
    const res = await post(POST, "gpt-x");
    expect(res.status).toBe(200);
    expect(tried()).toEqual(["cx/gpt-x", "ctso/openai-gpt-x"]);
  });

  it("stays on Codex when it answers", async () => {
    await post(POST, "gpt-x");
    expect(tried()).toEqual(["cx/gpt-x"]);
  });

  it("keeps compactions on Codex, still marked as compactions", async () => {
    state.results.cx = AUTH_FAILED;
    await post(compactPOST, "gpt-x");
    expect(state.tried).toEqual([{ model: "cx/gpt-x", compact: true }]);
  });

  it("keeps a turn carrying a compaction item on Codex", async () => {
    state.results.cx = AUTH_FAILED;
    await post(POST, "gpt-x", [{ type: "compaction", encrypted_content: "opaque" }, { role: "user", content: "hi" }]);
    expect(tried()).toEqual(["cx/gpt-x"]);
  });

  it.each(["fusion", "round-robin"])("runs Codex first even with a %s strategy set for the model", async (fallbackStrategy) => {
    state.settings = { comboStrategies: { "gpt-x": { fallbackStrategy } } };
    await post(POST, "gpt-x");
    state.resolved = 0;
    state.served = new Set();
    await post(POST, "gpt-x");
    expect(tried()).toEqual(["cx/gpt-x", "cx/gpt-x"]);
  });

  it("uses a Codex API-key account, as the cx/ pin did, though auto combos block pay per token", async () => {
    state.apiKeyOnly = new Set(["cx"]);
    const res = await post(POST, "gpt-x");
    expect(res.status).toBe(200);
    expect(tried()).toEqual(["cx/gpt-x"]);
  });

  it("answers with Codex's own request error rather than trying the others", async () => {
    state.results.cx = () => fail(400, "context_length_exceeded: the input is too long");
    const res = await post(POST, "gpt-x");
    expect(tried()).toEqual(["cx/gpt-x"]);
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("context_length_exceeded");
  });

  it("answers with the last provider's own reply when every one fails", async () => {
    state.results.cx = AUTH_FAILED;
    state.results.ctso = OTHER_REFUSED;
    const res = await post(POST, "gpt-x");
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("other provider refused");
  });

  describe("a rate-limited Codex with no fallback answering", () => {
    beforeEach(() => {
      state.results.cx = () => fail(429, CODEX_LIMIT_ERROR);
      state.results.ctso = OTHER_REFUSED;
      state.limited.cx = { allRateLimited: true, lastErrorCode: 429, lastError: CODEX_LIMIT_ERROR, retryAfter: CODEX_RESET, retryAfterHuman: "reset after 1m" };
    });

    it("answers with Codex's own limit, not the fallback's error", async () => {
      const res = await post(POST, "gpt-x");
      expect(tried()).toEqual(["cx/gpt-x", "ctso/openai-gpt-x"]);
      expect(res.status).toBe(429);
      const text = JSON.stringify(await res.json());
      expect(text).toContain("codex usage limit reached");
      expect(text).not.toContain("other provider refused");
    });

    it("gives a Codex client its terminal limits reply when every Codex account is used up, with the hold off", async () => {
      state.limited.cx.allLimitsExhausted = true;
      const res = await post(POST, "gpt-x", undefined, {}, { "user-agent": "codex-tui/0.1" });
      // Codex's own reply, not a second pass over Codex.
      expect(tried()).toEqual(["cx/gpt-x", "ctso/openai-gpt-x"]);
      expect(res.status).toBe(400);
      expect(res.headers.get("x-10router-upstream-status")).toBe("429");
      expect(await res.text()).toContain("All your accounts have hit their limits");
    });

    it("holds on the session's pinned Codex account, as the cx/ pin did, when the hold covers pinned accounts", async () => {
      state.codexId = true;
      state.hold = true;
      state.settings = { codexSessionAffinity: true, limitHoldOnPinned: true };
      state.results.codex = state.results.cx;
      const body = { prompt_cache_key: "session-x" };
      bindAffinity(affinityKeyFor({ provider: "codex", headers: {}, body }), "codex-1");
      const res = await post(POST, "gpt-x", undefined, { stream: false, ...body });
      // The pinned account waits; the turn doesn't move to Contoso.
      expect(tried()).toEqual(["codex/gpt-x"]);
      expect(state.held).toHaveLength(1);
      expect(await res.json()).toEqual({ held: true });
    });

    it("re-runs the hold under a spelling the key allows", async () => {
      state.combo = ["cx/gpt-x.1", "ctso/openai-gpt-x-1"];
      state.catalog = [{ id: "cx/gpt-x.1", provider: "codex" }, { id: "ctso/openai-gpt-x-1", provider: "ctso" }];
      state.keyAllows = ["gpt-x-1", "cx/gpt-x-1"];
      state.hold = true;
      state.runHeldAttempt = true;
      const res = await post(POST, "gpt-x-1", undefined, { stream: false });
      expect(state.held).toHaveLength(1);
      // Still Codex's limit after the wait, not a refusal of Codex's spelling.
      expect(res.status).toBe(429);
    });

    it("waits on Codex's reset when the limit hold is on", async () => {
      state.hold = true;
      // A JSON client, so the hold waits silently (awaitLimitClear) rather than narrating a stream.
      const res = await post(POST, "gpt-x", undefined, { stream: false });
      expect(state.held).toEqual([Date.parse(CODEX_RESET)]);
      expect(await res.json()).toEqual({ held: true });
    });
  });
});
