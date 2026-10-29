import { describe, it, expect, vi, beforeEach } from "vitest";

const aliases = vi.hoisted(() => ({ value: {} }));
const combos = vi.hoisted(() => ({ value: {} }));
const seen = vi.hoisted(() => ({ body: null, request: null }));
const autoCombo = vi.hoisted(() => ({ models: null, catalog: [] }));

vi.mock("@/lib/localDb", () => ({
  getModelAliases: async () => aliases.value,
  getComboByName: async (name) => combos.value[name] || null,
}));

vi.mock("@/sse/services/autoCombo.js", async (importOriginal) => ({
  ...(await importOriginal()),
  resolveAutoCombo: async () => autoCombo.models,
  getAutoComboCatalogMatches: () => autoCombo.catalog,
}));

vi.mock("@/sse/services/codexPooledUsage", () => ({
  getPooledCodexRateLimitHeaders: () => ({}),
}));

vi.mock("../../src/app/api/v1/responses/route.js", () => ({
  OPTIONS: () => new Response(null),
  POST: async (request) => {
    seen.request = request;
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
const { getRequestAutoCombo } = await import("@/sse/services/autoCombo.js");
const { routeCodexRequest } = await import("@/sse/services/codexIngress.js");

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
    seen.request = null;
    autoCombo.models = null;
    autoCombo.catalog = [];
  });

  it("routes a model Codex and others serve as an auto combo, Codex first", async () => {
    autoCombo.models = ["cx/gpt-6-astra", "snow/openai-gpt-6-astra"];
    autoCombo.catalog = [{ id: "cx/gpt-6-astra", provider: "codex" }, { id: "snow/openai-gpt-6-astra", provider: "snow" }];
    await post({ model: "gpt-6-astra", input: [] });
    expect(seen.body.model).toBe("gpt-6-astra");
    expect(getRequestAutoCombo(seen.request)).toEqual(["cx/gpt-6-astra", "snow/openai-gpt-6-astra"]);
  });

  it("pins a model only Codex serves to Codex", async () => {
    autoCombo.models = ["cx/gpt-6-astra"];
    autoCombo.catalog = [{ id: "cx/gpt-6-astra", provider: "codex" }];
    await post({ model: "gpt-6-astra", input: [] });
    expect(seen.body.model).toBe("cx/gpt-6-astra");
    expect(getRequestAutoCombo(seen.request)).toBeNull();
  });

  it("pins to the id Codex lists, not the client's spelling of it", async () => {
    autoCombo.models = ["cx/gpt-6-astra"];
    autoCombo.catalog = [{ id: "cx/gpt-6-astra", provider: "codex" }];
    await post({ model: "openai-gpt-6-astra[1m]", input: [] });
    expect(seen.body.model).toBe("cx/gpt-6-astra[1m]");
  });

  it("leaves a built-in alias alone", async () => {
    await post({ model: "grok-build", input: [] });
    expect(seen.body.model).toBe("grok-build");
  });

  it("routes a model Codex does not serve across the providers that do", async () => {
    autoCombo.models = ["cc/claude-opus-5-5"];
    autoCombo.catalog = [{ id: "cc/claude-opus-5-5", provider: "claude" }];
    await post({ model: "claude-opus-5-5", input: [] });
    expect(seen.body.model).toBe("claude-opus-5-5");
    expect(getRequestAutoCombo(seen.request)).toEqual(["cc/claude-opus-5-5"]);
  });

  it("keeps a model on Codex when auto combo settings leave Codex out", async () => {
    autoCombo.models = ["snow/openai-gpt-6-astra"];
    autoCombo.catalog = [{ id: "cx/gpt-6-astra", provider: "codex" }, { id: "snow/openai-gpt-6-astra", provider: "snow" }];
    await post({ model: "gpt-6-astra", input: [] });
    expect(seen.body.model).toBe("cx/gpt-6-astra");
    expect(getRequestAutoCombo(seen.request)).toBeNull();
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
  beforeEach(() => { aliases.value = {}; combos.value = {}; autoCombo.models = null; autoCombo.catalog = []; });

  it.each([
    ["an explicit provider/model", () => {}, "cc/claude-opus-5-5"],
    ["a request with no model", () => {}, undefined],
    ["an alias", () => { aliases.value = { "my-alias": "cc/claude-opus-5-5" }; }, "my-alias"],
    ["a combo", () => { combos.value = { "my-combo": { name: "my-combo" } }; }, "my-combo"],
    ["an auto combo", () => {
      autoCombo.models = ["cc/claude-opus-5-5"];
      autoCombo.catalog = [{ id: "cc/claude-opus-5-5", provider: "claude" }];
    }, "claude-opus-5-5"],
    ["the Codex fallback", () => {}, "gpt-5.6-luna"],
  ])("keeps the extra body fields on %s", async (_name, arrange, model) => {
    arrange();
    const body = await (await routeCodexRequest(req({ model, input: [] }), { _compact: true })).json();
    expect(body._compact).toBe(true);
    expect(body.input).toEqual([]);
  });

  it("keeps a compaction on Codex even when other providers serve the model", async () => {
    autoCombo.models = ["cx/gpt-6-astra", "snow/openai-gpt-6-astra"];
    autoCombo.catalog = [{ id: "cx/gpt-6-astra", provider: "codex" }, { id: "snow/openai-gpt-6-astra", provider: "snow" }];
    const routed = await routeCodexRequest(req({ model: "gpt-6-astra", input: [] }), { _compact: true });
    expect((await routed.json()).model).toBe("cx/gpt-6-astra");
    expect(getRequestAutoCombo(routed)).toBeNull();
  });

  it("hands the client's own request on when it changes nothing, so its abort signal still reaches handleChat", async () => {
    const original = req({ model: "cc/claude-opus-5-5", input: [] });
    await expect(routeCodexRequest(original)).resolves.toBe(original);
  });

  it("carries the client's abort signal onto a rewritten request", async () => {
    const controller = new AbortController();
    const original = new Request("http://local/backend-api/codex/responses", {
      method: "POST", body: JSON.stringify({ model: "gpt-5.6-luna" }), signal: controller.signal,
    });
    const routed = await routeCodexRequest(original);
    controller.abort();
    expect(routed.signal.aborted).toBe(true);
  });
});
