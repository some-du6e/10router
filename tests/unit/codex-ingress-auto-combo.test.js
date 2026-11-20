import { describe, it, expect, vi, beforeEach } from "vitest";

// The Codex ingress through the real Codex routes and the real account loop in
// handleChat, with the catalog and provider layer stubbed: a model Codex and
// another provider both serve tries Codex, then falls back.
const state = vi.hoisted(() => ({
  combo: null, catalog: [], resolved: 0, tried: [], served: new Set(), results: {}, limited: {},
  settings: {}, hold: false, held: [], apiKeyOnly: new Set(),
  // accounts: how many accounts a provider has (default 1); taken: how many were handed out.
  accounts: {}, taken: {},
  // codexId: cx/ resolves to the real provider id "codex" (session affinity needs it).
  // keyAllows: models the client key may use, null = no allowlist.
  // runHeldAttempt: the hold re-runs the request once, with every account
  // usable again as after the reset (still limited once used), instead of
  // answering at once.
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
  // One account per provider unless state.accounts says more. Once all are
  // tried they are gone, or rate-limited when the test says so.
  // A provider in apiKeyOnly has just a Codex API-key account, which an auto
  // combo's billing filter (pay per token blocked by default) would skip.
  getProviderCredentials: async (provider, _exclude, _model, options) => {
    if (state.apiKeyOnly.has(provider) && options?.connectionFilter && !options.connectionFilter({ provider: "codex", authType: "apikey" })) return null;
    if (state.served.has(provider)) return state.limited[provider] || null;
    const n = (state.taken[provider] || 0) + 1;
    state.taken[provider] = n;
    if (n >= (state.accounts[provider] || 1)) state.served.add(provider);
    return { connectionId: `${provider}-${n}`, connectionName: `${provider}-${n}`, accessToken: "t" };
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
    if (state.runHeldAttempt) {
      state.served = new Set();
      state.taken = {};
      return { response: (await attempt()).response };
    }
    return { response: new Response('{"held":true}', { headers: { "Content-Type": "application/json" } }) };
  },
}));
vi.mock("open-sse/handlers/chatCore.js", async (importOriginal) => ({
  ...(await importOriginal()),
  handleChatCore: async ({ modelInfo, body, connectionId }) => {
    state.tried.push({ model: `${modelInfo.provider}/${modelInfo.model}`, compact: body._compact === true });
    // Results are factories: a Response body can be read only once. Keyed by
    // account (`cx-2`) or by provider.
    return (state.results[connectionId] || state.results[modelInfo.provider])?.() || { success: true, response: new Response('{"ok":true}', { headers: { "Content-Type": "application/json" } }) };
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
  state.accounts = {};
  state.taken = {};
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

  it("falls back past Codex's refusal of the model on a ChatGPT plan", async () => {
    state.results.cx = () => fail(400, "The 'gpt-x' model is not supported when using Codex with a ChatGPT account.");
    const res = await post(POST, "gpt-x");
    expect(tried()).toEqual(["cx/gpt-x", "ctso/openai-gpt-x"]);
    expect(res.status).toBe(200);
  });

  it("answers with one Codex account's request error though another refused the model on its plan", async () => {
    state.accounts.cx = 2;
    state.results["cx-1"] = () => fail(400, "The 'gpt-x' model is not supported when using Codex with a ChatGPT account.");
    state.results["cx-2"] = () => fail(400, "Your input exceeds the context window of this model.");
    const res = await post(POST, "gpt-x");
    expect(tried()).toEqual(["cx/gpt-x", "cx/gpt-x"]);
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("context window");
  });

  it("falls back past a Codex 413 that doesn't say why", async () => {
    state.results.cx = () => fail(413, "");
    const res = await post(POST, "gpt-x");
    expect(tried()).toEqual(["cx/gpt-x", "ctso/openai-gpt-x"]);
    expect(res.status).toBe(200);
  });

  it("answers with a Codex 413 that says the request is too large", async () => {
    state.results.cx = () => fail(413, "Request body is too large for this model.");
    const res = await post(POST, "gpt-x");
    expect(tried()).toEqual(["cx/gpt-x"]);
    expect(res.status).toBe(413);
  });

  it("falls back past a Codex 404", async () => {
    state.results.cx = () => fail(404, "not found");
    const res = await post(POST, "gpt-x");
    expect(tried()).toEqual(["cx/gpt-x", "ctso/openai-gpt-x"]);
    expect(res.status).toBe(200);
  });

  it("falls back when every Codex account is locked on another request's too-long 400", async () => {
    // Another conversation's 400 locked the model on the Codex account; this
    // request reaches no Codex account and gets that stored error.
    state.served = new Set(["cx"]);
    state.limited.cx = {
      allRateLimited: true, lastErrorCode: 400, lastError: "context_length_exceeded: the input is too long",
      retryAfter: CODEX_RESET, retryAfterHuman: "reset after 1m",
    };
    const res = await post(POST, "gpt-x");
    expect(tried()).toEqual(["ctso/openai-gpt-x"]);
    expect(res.status).toBe(200);
  });

  describe("a rate-limited Codex with the hold on and the other provider answering", () => {
    beforeEach(() => {
      state.hold = true;
      state.results.cx = () => fail(429, CODEX_LIMIT_ERROR);
      state.limited.cx = { allRateLimited: true, lastErrorCode: 429, lastError: CODEX_LIMIT_ERROR, retryAfter: CODEX_RESET, retryAfterHuman: "reset after 1m" };
    });

    it("falls back without holding", async () => {
      const res = await post(POST, "gpt-x", undefined, { stream: false });
      expect(tried()).toEqual(["cx/gpt-x", "ctso/openai-gpt-x"]);
      expect(state.held).toEqual([]);
      expect(res.status).toBe(200);
    });

    it("falls back without holding when the hold covers pinned accounts but the session isn't pinned", async () => {
      state.codexId = true;
      state.settings = { codexSessionAffinity: true, limitHoldOnPinned: true };
      state.results.codex = state.results.cx;
      state.limited.codex = state.limited.cx;
      const res = await post(POST, "gpt-x", undefined, { stream: false, prompt_cache_key: "session-never-bound" });
      expect(tried()).toEqual(["codex/gpt-x", "ctso/openai-gpt-x"]);
      expect(state.held).toEqual([]);
      expect(res.status).toBe(200);
    });
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

    it("holds the pinned Codex account once: a hold that still fails isn't held again", async () => {
      state.codexId = true;
      state.hold = true;
      state.runHeldAttempt = true;
      state.settings = { codexSessionAffinity: true, limitHoldOnPinned: true };
      state.results.codex = state.results.cx;
      // Still limited after the wait, so a second hold would have something to wait on.
      state.limited.codex = state.limited.cx;
      const body = { prompt_cache_key: "session-held-once" };
      bindAffinity(affinityKeyFor({ provider: "codex", headers: {}, body }), "codex-1");
      const res = await post(POST, "gpt-x", undefined, { stream: false, ...body });
      expect(state.held).toHaveLength(1);
      expect(tried()).toEqual(["codex/gpt-x", "codex/gpt-x", "ctso/openai-gpt-x"]);
      expect(res.status).toBe(429);
    });

    it("re-runs the hold on Codex's own id when the key allows only the client's spelling", async () => {
      state.combo = ["cx/gpt-x.1", "ctso/openai-gpt-x-1"];
      state.catalog = [{ id: "cx/gpt-x.1", provider: "codex" }, { id: "ctso/openai-gpt-x-1", provider: "ctso" }];
      state.keyAllows = ["gpt-x-1", "ctso/openai-gpt-x-1"];
      state.hold = true;
      state.runHeldAttempt = true;
      const res = await post(POST, "gpt-x-1", undefined, { stream: false });
      expect(state.held).toHaveLength(1);
      // After the wait Codex gets the id it lists, not the client's spelling.
      expect(tried()).toEqual(["cx/gpt-x.1", "ctso/openai-gpt-x-1", "cx/gpt-x.1"]);
      // Still Codex's limit after the wait, not a refusal by the key's allowlist.
      expect(res.status).toBe(429);
    });

    it("holds a pinned Codex account whose id the key allows only under the client's spelling", async () => {
      state.combo = ["cx/gpt-x.1", "ctso/openai-gpt-x-1"];
      state.catalog = [{ id: "cx/gpt-x.1", provider: "codex" }, { id: "ctso/openai-gpt-x-1", provider: "ctso" }];
      state.keyAllows = ["gpt-x-1", "ctso/openai-gpt-x-1"];
      state.codexId = true;
      state.hold = true;
      state.runHeldAttempt = true;
      state.settings = { codexSessionAffinity: true, limitHoldOnPinned: true };
      state.results.codex = () => fail(429, CODEX_LIMIT_ERROR);
      state.results.ctso = OTHER_REFUSED;
      const body = { prompt_cache_key: "session-dotted" };
      bindAffinity(affinityKeyFor({ provider: "codex", headers: {}, body }), "codex-1");
      const res = await post(POST, "gpt-x-1", undefined, { stream: false, ...body });
      expect(state.held).toHaveLength(1);
      // The hold re-ran Codex rather than ending on the allowlist.
      expect(tried()).toEqual(["codex/gpt-x.1", "codex/gpt-x.1", "ctso/openai-gpt-x-1"]);
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
