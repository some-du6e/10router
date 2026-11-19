import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const aliases = vi.hoisted(() => ({ value: {} }));
const combos = vi.hoisted(() => ({ value: {} }));
const seen = vi.hoisted(() => ({ body: null }));
// `hang` makes the auto-combo catalog build never finish, as when the server
// has just started and its first build is stuck.
const connections = vi.hoisted(() => ({ hang: false }));

vi.mock("@/lib/localDb", () => ({
  getModelAliases: async () => aliases.value,
  getComboByName: async (name) => combos.value[name] || null,
  // No provider connected, so the auto-combo catalog builds empty at once.
  getProviderConnections: () => (connections.hang ? new Promise(() => {}) : Promise.resolve([])),
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

  describe("while the model list is still building after a restart", () => {
    // A fresh module set, so the catalog starts cold.
    async function coldPost(body, signal) {
      delete globalThis._autoComboCatalog;
      vi.resetModules();
      const { POST: coldPOST } = await import("@/app/api/v1/codex/responses/route.js");
      return coldPOST(new Request("http://local/backend-api/codex/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      }));
    }

    afterEach(() => {
      connections.hang = false;
      vi.useRealTimers();
      delete globalThis._autoComboCatalog;
    });

    it("goes ahead after about 20 s, well before a proxy's ~100 s limit", async () => {
      connections.hang = true;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      let done = false;
      const pending = coldPost({ model: "gpt-5.6-luna", input: [] }).then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(19_500);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      await pending;
      expect(seen.body.model).toBe("cx/gpt-5.6-luna");
    });

    it("stops waiting as soon as the client hangs up", async () => {
      connections.hang = true;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const controller = new AbortController();
      let done = false;
      const pending = coldPost({ model: "gpt-5.6-luna", input: [] }, controller.signal).then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(done).toBe(false);
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      await pending;
      expect(done).toBe(true);
    });
  });

  it("passes a bodyless or non-JSON request straight through", async () => {
    const response = await POST(new Request("http://local/backend-api/codex/responses", {
      method: "POST",
      body: "not json",
    }));
    expect(response.status).toBe(200);
  });
});
