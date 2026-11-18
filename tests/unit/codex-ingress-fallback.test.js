import { describe, it, expect, vi, beforeEach } from "vitest";

const aliases = vi.hoisted(() => ({ value: {} }));
const combos = vi.hoisted(() => ({ value: {} }));
// What the Codex route handed handleChat: the body it forwarded and the options.
const seen = vi.hoisted(() => ({ body: null, request: null, opts: null }));
const autoCombo = vi.hoisted(() => ({ models: null, catalog: [] }));
// Models the client key may use; null = no allowlist.
const keyAllows = vi.hoisted(() => ({ value: null }));

vi.mock("@/lib/localDb", () => ({
  getModelAliases: async () => aliases.value,
  getComboByName: async (name) => combos.value[name] || null,
}));

vi.mock("@/sse/services/autoCombo.js", async (importOriginal) => ({
  ...(await importOriginal()),
  resolveAutoCombo: async () => autoCombo.models,
  getAutoComboCatalogMatches: () => autoCombo.catalog,
}));

vi.mock("@/sse/services/keyLimits.js", () => ({
  requestKeyAllowsModel: async (_request, model) => keyAllows.value === null || keyAllows.value.includes(model),
}));

vi.mock("@/sse/services/codexPooledUsage", () => ({
  getPooledCodexRateLimitHeaders: () => ({}),
}));

vi.mock("@/sse/handlers/chat.js", () => ({
  handleChat: async (request, _raw, opts) => {
    seen.request = request;
    seen.opts = opts ?? null;
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
const { routeCodexRequest } = await import("@/sse/services/codexIngress.js");

const post = (body) => POST(new Request("http://local/backend-api/codex/responses", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
}));

const CODEX_AND_OTHER = {
  models: ["cx/gpt-x", "ctso/openai-gpt-x"],
  catalog: [{ id: "cx/gpt-x", provider: "codex" }, { id: "ctso/openai-gpt-x", provider: "ctso" }],
};

beforeEach(() => {
  aliases.value = {};
  combos.value = {};
  seen.body = null;
  seen.request = null;
  seen.opts = null;
  autoCombo.models = null;
  autoCombo.catalog = [];
  keyAllows.value = null;
});

describe("Codex ingress model fallback", () => {
  it("routes a model Codex and others serve as an auto combo, Codex first", async () => {
    Object.assign(autoCombo, CODEX_AND_OTHER);
    await post({ model: "gpt-x", input: [] });
    expect(seen.body.model).toBe("gpt-x");
    expect(seen.opts).toMatchObject({ earlyHeaders: true, autoCombo: ["cx/gpt-x", "ctso/openai-gpt-x"], autoComboHome: ["cx/gpt-x"] });
  });

  it("puts Codex first even when the auto combo ranked it later", async () => {
    autoCombo.models = ["kr/gpt-x", "cx/gpt-x", "cc/gpt-x"];
    autoCombo.catalog = [{ id: "kr/gpt-x", provider: "kiro" }, { id: "cx/gpt-x", provider: "codex" }, { id: "cc/gpt-x", provider: "claude" }];
    await post({ model: "gpt-x", input: [] });
    expect(seen.opts.autoCombo).toEqual(["cx/gpt-x", "kr/gpt-x", "cc/gpt-x"]);
  });

  it("keeps a model on Codex for a client key allowed only the Codex model", async () => {
    Object.assign(autoCombo, CODEX_AND_OTHER);
    keyAllows.value = ["cx/gpt-x"];
    await post({ model: "gpt-x", input: [] });
    expect(seen.body.model).toBe("cx/gpt-x");
    expect(seen.opts.autoCombo).toBeUndefined();

    keyAllows.value = ["gpt-x"];
    await post({ model: "gpt-x", input: [] });
    expect(seen.body.model).toBe("gpt-x");
    expect(seen.opts.autoCombo).toEqual(["cx/gpt-x", "ctso/openai-gpt-x"]);
  });

  it("keeps a turn carrying a compaction item on Codex", async () => {
    Object.assign(autoCombo, CODEX_AND_OTHER);
    await post({ model: "gpt-x", input: [{ type: "compaction", encrypted_content: "opaque" }, { role: "user", content: "hi" }] });
    expect(seen.body.model).toBe("cx/gpt-x");
    expect(seen.opts.autoCombo).toBeUndefined();
  });

  it("still falls back for a turn whose only encrypted items are reasoning", async () => {
    Object.assign(autoCombo, CODEX_AND_OTHER);
    await post({ model: "gpt-x", input: [{ type: "reasoning", summary: [], encrypted_content: "opaque" }, { role: "user", content: "hi" }] });
    expect(seen.body.model).toBe("gpt-x");
    expect(seen.opts.autoCombo).toEqual(["cx/gpt-x", "ctso/openai-gpt-x"]);
  });

  it("pins a model only Codex serves to Codex", async () => {
    autoCombo.models = ["cx/gpt-x"];
    autoCombo.catalog = [{ id: "cx/gpt-x", provider: "codex" }];
    await post({ model: "gpt-x", input: [] });
    expect(seen.body.model).toBe("cx/gpt-x");
    expect(seen.opts.autoCombo).toBeUndefined();
  });

  it("pins to the id Codex lists, not the client's spelling of it", async () => {
    autoCombo.models = ["cx/gpt-x"];
    autoCombo.catalog = [{ id: "cx/gpt-x", provider: "codex" }];
    await post({ model: "openai-gpt-x[1m]", input: [] });
    expect(seen.body.model).toBe("cx/gpt-x[1m]");
  });

  it("leaves a built-in alias alone", async () => {
    await post({ model: "grok-build", input: [] });
    expect(seen.body.model).toBe("grok-build");
  });

  it("leaves a model Codex does not serve to handleChat's own auto combo, as on /v1", async () => {
    autoCombo.models = ["cc/claude-x", "kr/claude-x"];
    autoCombo.catalog = [{ id: "cc/claude-x", provider: "claude" }, { id: "kr/claude-x", provider: "kiro" }];
    await post({ model: "claude-x", input: [] });
    expect(seen.body.model).toBe("claude-x");
    expect(seen.opts).toEqual({ earlyHeaders: true });
  });

  it("pins with the client's spelling when the key allows only that", async () => {
    autoCombo.models = ["cx/gpt-x"];
    autoCombo.catalog = [{ id: "cx/gpt-x", provider: "codex" }];
    keyAllows.value = ["cx/openai-gpt-x"];
    await post({ model: "openai-gpt-x", input: [] });
    expect(seen.body.model).toBe("cx/openai-gpt-x");

    keyAllows.value = ["cx/gpt-x"];
    await post({ model: "openai-gpt-x", input: [] });
    expect(seen.body.model).toBe("cx/gpt-x");
  });

  it("keeps a model on Codex when auto combo settings leave Codex out", async () => {
    autoCombo.models = ["ctso/openai-gpt-x"];
    autoCombo.catalog = CODEX_AND_OTHER.catalog;
    await post({ model: "gpt-x", input: [] });
    expect(seen.body.model).toBe("cx/gpt-x");
    expect(seen.opts.autoCombo).toBeUndefined();
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

  it("matches a combo through a [1m] context selector", async () => {
    // Regression: t3 code / Claude Code append `[1m]` when the 1M-context beta
    // is on. The selector is not part of the stored combo name, so an unstripped
    // lookup missed, the id fell through to `cx/`, and Codex answered 400
    // "The 'claude-opus-5' model is not supported ... with a ChatGPT account" —
    // while the same combo without the selector routed to Claude fine.
    combos.value = { "claude-opus-5": { name: "claude-opus-5" } };
    await post({ model: "claude-opus-5[1m]", input: [] });
    expect(seen.body.model).toBe("claude-opus-5[1m]");
  });

  it("matches an alias through a [1m] context selector", async () => {
    aliases.value = { "claude-opus-5": "cc/claude-opus-5" };
    await post({ model: "claude-opus-5[1M]", input: [] });
    expect(seen.body.model).toBe("claude-opus-5[1M]");
  });

  it("still falls back to Codex for an unknown model with a selector", async () => {
    await post({ model: "gpt-5.6-luna[1m]", input: [] });
    expect(seen.body.model).toBe("cx/gpt-5.6-luna[1m]");
  });

  it("passes a bodyless or non-JSON request straight through", async () => {
    const response = await POST(new Request("http://local/backend-api/codex/responses", {
      method: "POST",
      body: "not json",
    }));
    expect(response.status).toBe(200);
  });
});

describe("routeCodexRequest", () => {
  const req = (body) => new Request("http://local/backend-api/codex/responses/compact", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

  it.each([
    ["an explicit provider/model", () => {}, "cc/claude-x", "cc/claude-x", null],
    ["a request with no model", () => {}, undefined, undefined, null],
    ["an alias", () => { aliases.value = { "my-alias": "cc/claude-x" }; }, "my-alias", "my-alias", null],
    ["a combo", () => { combos.value = { "my-combo": { name: "my-combo" } }; }, "my-combo", "my-combo", null],
    ["a model only other providers serve", () => {
      autoCombo.models = ["cc/claude-x"];
      autoCombo.catalog = [{ id: "cc/claude-x", provider: "claude" }];
    }, "claude-x", "claude-x", null],
    ["a model Codex and others serve", () => Object.assign(autoCombo, CODEX_AND_OTHER), "gpt-x", "cx/gpt-x", null],
    ["the Codex fallback", () => {}, "gpt-y", "cx/gpt-y", null],
  ])("keeps the compaction flag on %s", async (_name, arrange, model, routedModel, attached) => {
    arrange();
    const routed = await routeCodexRequest(req({ model, input: [] }), { compact: true });
    const body = await routed.request.json();
    expect(body._compact).toBe(true);
    expect(body.input).toEqual([]);
    expect(body.model).toBe(routedModel);
    expect(routed.autoCombo).toEqual(attached);
  });

  it("keeps a compaction on Codex even when other providers serve the model", async () => {
    Object.assign(autoCombo, CODEX_AND_OTHER);
    const routed = await routeCodexRequest(req({ model: "gpt-x", input: [] }), { compact: true });
    expect((await routed.request.json()).model).toBe("cx/gpt-x");
    expect(routed.autoCombo).toBeNull();
  });

  it("hands the client's own request on when it changes nothing, so its abort signal still reaches handleChat", async () => {
    const original = req({ model: "cc/claude-x", input: [] });
    expect((await routeCodexRequest(original)).request).toBe(original);
  });

  it("carries the client's abort signal onto a rewritten request", async () => {
    const controller = new AbortController();
    const original = new Request("http://local/backend-api/codex/responses", {
      method: "POST", body: JSON.stringify({ model: "gpt-y" }), signal: controller.signal,
    });
    const routed = await routeCodexRequest(original);
    controller.abort();
    expect(routed.request.signal.aborted).toBe(true);
  });
});
