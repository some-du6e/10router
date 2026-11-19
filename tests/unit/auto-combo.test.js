// A bare model id with no combo behind it falls back across every connected
// provider that serves it, so clients like Claude Code need no hand-made combo.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// /v1/models lists models under each connection's output prefix; the test
// controls that list directly and connects whichever providers it names.
// `gate`, when set, is a promise each build waits on: a slow upstream /models.
// `fail` makes a build throw, as when the database or every upstream errors.
// `gates` hands one promise to each build in turn, to pace overlapping builds.
// `timedOut` lists the prefixes of providers whose live catalog timed out in
// the build, which buildModelsList reports through onLiveTimeout.
const catalog = vi.hoisted(() => ({ ids: [], hang: false, builds: 0, gate: null, fail: false, gates: [], timedOut: [] }));
vi.mock("@/app/api/v1/models/route.js", () => ({
  buildModelsList: async (_kinds, options = {}) => {
    catalog.builds++;
    if (catalog.hang) await new Promise(() => {});
    if (catalog.fail) throw new Error("upstream /models failed");
    if (catalog.gates.length) await catalog.gates.shift();
    if (catalog.gate) await catalog.gate;
    for (const alias of catalog.timedOut) options.onLiveTimeout?.(alias, { alias });
    return catalog.ids.map((id) => ({ id, object: "model", owned_by: id.split("/")[0] }));
  },
}));

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-auto-combo-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  delete global._settingsCache;
  delete global._autoComboCatalog;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  delete global._settingsCache;
  delete global._autoComboCatalog;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

// conns: [{ provider, authType?, prefix? }]. `warm: false` leaves the catalog
// cold, as right after the server starts.
async function setup(ids, conns = [], settings = null, { warm = true } = {}) {
  catalog.ids = ids;
  const db = await import("@/lib/localDb.js");
  for (const c of conns) {
    await db.createProviderConnection({
      provider: c.provider,
      authType: c.authType || "oauth",
      name: `${c.provider}-test`,
      apiKey: "k",
      accessToken: "t",
      isActive: true,
      ...(c.prefix ? { providerSpecificData: { prefix: c.prefix } } : {}),
    });
  }
  if (settings) await db.updateSettings(settings);
  const auto = await import("@/sse/services/autoCombo.ts");
  if (warm) await auto.warmAutoComboCatalog();
  return { ...db, ...auto };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// Settles `promise` into a box so a test can see whether it is still pending.
function track(promise) {
  const box = { settled: false, value: undefined };
  promise.then((value) => { box.settled = true; box.value = value; });
  return box;
}

const SUBS = [{ provider: "claude" }, { provider: "codex" }, { provider: "kiro" }];

describe("auto combos", () => {
  it("falls back across every unblocked provider serving a bare id, free first", async () => {
    const ctx = await setup(
      ["cc/claude-opus-5-5", "kr/claude-opus-5.5", "cx/gpt-9", "cc/claude-sonnet-5-5"],
      SUBS,
    );

    await expect(ctx.resolveAutoCombo("claude-opus-5-5[1m]")).resolves.toEqual([
      "kr/claude-opus-5.5",
      "cc/claude-opus-5-5",
    ]);
  });

  it("matches ids a provider lists with an openai- prefix, either way round", async () => {
    const ctx = await setup(["ctso/openai-gpt-x", "cx/gpt-x"], [...SUBS, { provider: "openai-compatible-chat-x", prefix: "ctso" }], { autoComboBlockedBilling: [] });

    await expect(ctx.resolveAutoCombo("gpt-x")).resolves.toEqual(["cx/gpt-x", "ctso/openai-gpt-x"]);
    await expect(ctx.resolveAutoCombo("openai-gpt-x")).resolves.toEqual(["cx/gpt-x", "ctso/openai-gpt-x"]);
  });

  it("strips openai- only as a prefix", async () => {
    const ctx = await setup(["ctso/gpt-openai-x", "cx/gpt-x"], [...SUBS, { provider: "openai-compatible-chat-x", prefix: "ctso" }], { autoComboBlockedBilling: [] });

    await expect(ctx.resolveAutoCombo("gpt-x")).resolves.toEqual(["cx/gpt-x"]);
  });

  it("tells a plain bare id from a prefixed id, a combo or an alias", async () => {
    const ctx = await setup([], SUBS);
    await ctx.createCombo({ name: "my-combo", models: ["cc/claude-x"] });
    await ctx.setModelAlias("my-alias", "cc/claude-x");

    await expect(ctx.isPlainBareId("gpt-x[1m]")).resolves.toBe(true);
    await expect(ctx.isPlainBareId("cx/gpt-x")).resolves.toBe(false);
    await expect(ctx.isPlainBareId("my-combo[1m]")).resolves.toBe(false);
    await expect(ctx.isPlainBareId("my-alias")).resolves.toBe(false);
    await expect(ctx.isPlainBareId("grok-build", { "grok-build": "gcli/grok-build" })).resolves.toBe(false);
    await expect(ctx.billingPolicyApplies("gpt-x")).resolves.toBe(true);
    await expect(ctx.billingPolicyApplies("my-alias")).resolves.toBe(false);
  });

  it("lists every catalog entry serving a bare id with its provider, ignoring auto combo settings", async () => {
    const ctx = await setup(
      ["cx/gpt-x", "ctso/openai-gpt.x", "cc/claude-x"],
      [...SUBS, { provider: "openai-compatible-chat-x", prefix: "ctso" }],
      { autoComboExcludedProviders: ["codex"] },
    );
    expect(ctx.getAutoComboCatalogMatches("gpt-x[1m]")).toEqual([
      { id: "cx/gpt-x", provider: "codex" },
      { id: "ctso/openai-gpt.x", provider: "openai-compatible-chat-x" },
    ]);
  });

  it("routes a single match through the same path", async () => {
    const ctx = await setup(["cc/claude-haiku-5-5", "kr/claude-opus-5-5"], SUBS);

    await expect(ctx.resolveAutoCombo("claude-haiku-5-5")).resolves.toEqual(["cc/claude-haiku-5-5"]);
  });

  it("leaves hand-made combos, user aliases and built-in aliases in charge", async () => {
    const ctx = await setup(["cc/claude-opus-5-5", "kr/claude-opus-5-5", "kr/grok-build"], SUBS);
    await ctx.createCombo({ name: "claude-opus-5-5", models: ["cc/claude-opus-5-5"] });
    await ctx.setModelAlias("opus", "cc/claude-opus-5-5");

    await expect(ctx.resolveAutoCombo("claude-opus-5-5")).resolves.toBeNull();
    await expect(ctx.resolveAutoCombo("opus")).resolves.toBeNull();
    await expect(ctx.resolveAutoCombo("grok-build", { "grok-build": "gcli/grok-build" })).resolves.toBeNull();
  });

  it("blocks pay-per-token, free-tier and custom providers by default", async () => {
    const ctx = await setup(
      ["openai/gpt-9", "openrouter/openai/gpt-9", "mine/gpt-9", "cx/gpt-9", "kr/gpt-9"],
      [
        { provider: "openai", authType: "apikey" },
        { provider: "openrouter", authType: "apikey" },
        { provider: "openai-compatible-mine", authType: "apikey", prefix: "mine" },
        ...SUBS,
      ],
    );

    await expect(ctx.getAutoComboModels("gpt-9")).resolves.toEqual(["kr/gpt-9", "cx/gpt-9"]);

    await ctx.updateSettings({ autoComboBlockedBilling: ["subscription"] });
    await expect(ctx.getAutoComboModels("gpt-9")).resolves.toEqual([
      "kr/gpt-9",
      "openrouter/openai/gpt-9",
      "mine/gpt-9",
      "openai/gpt-9",
    ]);
  });

  it("classes providers listed under a uiAlias by their real billing", async () => {
    // perplexity-agent is pay per token and lists models as pa/...
    const ctx = await setup(["pa/anthropic/claude-opus-4-8", "cc/claude-opus-4-8"], [
      { provider: "perplexity-agent", authType: "apikey" },
      { provider: "claude" },
    ]);

    await expect(ctx.getAutoComboModels("claude-opus-4-8")).resolves.toEqual(["cc/claude-opus-4-8"]);
  });

  it("treats an OAuth provider connected with an API key as pay per token", async () => {
    const ctx = await setup(["xai/grok-9", "kr/grok-9"], [
      { provider: "xai", authType: "apikey" },
      { provider: "kiro" },
    ]);

    await expect(ctx.getAutoComboModels("grok-9")).resolves.toEqual(["kr/grok-9"]);
  });

  it("keeps a provider with an allowed account, and never hands out its blocked ones", async () => {
    // One xAI login (subscription) plus one xAI API key (pay per token).
    const ctx = await setup(["xai/grok-9"], [
      { provider: "xai" },
      { provider: "xai", authType: "apikey" },
    ]);
    await expect(ctx.getAutoComboModels("grok-9")).resolves.toEqual(["xai/grok-9"]);

    const { getProviderCredentials } = await import("@/sse/services/auth.js");
    const blocked = ctx.blockedBillingSets(await ctx.getSettings());
    const connectionFilter = (c) => !blocked.has(ctx.connectionBilling(c));
    const picked = new Set();
    const exclude = new Set();
    for (;;) {
      const creds = await getProviderCredentials("xai", exclude, "grok-9", { connectionFilter });
      if (!creds?.connectionId) break;
      picked.add(creds.connectionId);
      exclude.add(creds.connectionId);
    }
    const conns = await ctx.getProviderConnections({ provider: "xai" });
    const oauth = conns.find((c) => c.authType === "oauth");
    expect([...picked]).toEqual([oauth.id]);
  });

  it("bills credit-based OAuth providers and api_key spellings per token", async () => {
    const { connectionBilling } = await setup([]);
    expect(connectionBilling({ provider: "cline", authType: "oauth" })).toBe("payg");
    expect(connectionBilling({ provider: "kilocode", authType: "oauth" })).toBe("payg");
    expect(connectionBilling({ provider: "xai", authType: "api_key" })).toBe("payg");
    expect(connectionBilling({ provider: "claude", authType: "oauth" })).toBe("subscription");
  });

  it("does not make every request wait while a slow catalog build runs", async () => {
    const ctx = await setup(["cc/m-3"], [{ provider: "claude" }]);
    // A connection change makes the list stale; the rebuild then hangs.
    catalog.hang = true;
    await ctx.createProviderConnection({ provider: "kiro", authType: "oauth", name: "kiro-2", accessToken: "t", isActive: true });
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    try {
      const first = ctx.getAutoComboModels("m-3");
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(first).resolves.toEqual(["cc/m-3"]);
      // The wait is spent: later requests use the old list at once.
      const start = Date.now();
      await expect(ctx.getAutoComboModels("m-3")).resolves.toEqual(["cc/m-3"]);
      expect(Date.now() - start).toBe(0);
    } finally {
      catalog.hang = false;
      vi.useRealTimers();
    }
  });

  it("skips excluded providers by prefix or id", async () => {
    const ctx = await setup(
      ["cc/claude-sonnet-5-5", "kr/claude-sonnet-5-5", "cx/claude-sonnet-5-5"],
      SUBS,
      { autoComboExcludedProviders: ["cc", "codex"] },
    );

    await expect(ctx.getAutoComboModels("claude-sonnet-5-5")).resolves.toEqual(["kr/claude-sonnet-5-5"]);
  });

  it("ignores malformed settings instead of failing every request", async () => {
    const ctx = await setup(["cc/m-1", "kr/m-1"], SUBS, {
      autoComboBlockedBilling: "subscription",
      autoComboExcludedProviders: { cc: true },
    });

    await expect(ctx.getAutoComboModels("m-1")).resolves.toEqual(["kr/m-1", "cc/m-1"]);
  });

  it("does nothing when no provider is connected", async () => {
    const ctx = await setup(["cc/claude-fable-5-1", "kr/claude-fable-5-1"]);

    await expect(ctx.resolveAutoCombo("claude-fable-5-1")).resolves.toBeNull();
  });

  it("picks up a new connection without waiting out the cache", async () => {
    const ctx = await setup(["cc/m-2", "kr/m-2"], [{ provider: "claude" }]);
    await expect(ctx.getAutoComboModels("m-2")).resolves.toEqual(["cc/m-2"]);

    await ctx.createProviderConnection({ provider: "kiro", authType: "oauth", name: "kiro-test", accessToken: "t", isActive: true });
    await expect(ctx.getAutoComboModels("m-2")).resolves.toEqual(["kr/m-2", "cc/m-2"]);
  });

  it("ignores unknown and provider-prefixed ids", async () => {
    const ctx = await setup(["cc/claude-opus-5-5", "kr/claude-opus-5-5"], SUBS);

    await expect(ctx.resolveAutoCombo("nope-1")).resolves.toBeNull();
    await expect(ctx.resolveAutoCombo("cc/claude-opus-5-5")).resolves.toBeNull();
  });

  it("keeps a bare id on allowed accounts even when no auto combo forms", async () => {
    const ctx = await setup(["anthropic/claude-opus-5-5"], [{ provider: "anthropic", authType: "apikey" }]);
    // Only a blocked provider serves it, so nothing forms and routing falls to
    // the name: claude-* goes to Anthropic. That must still skip the key.
    await expect(ctx.resolveAutoCombo("claude-opus-5-5")).resolves.toBeNull();
    await expect(ctx.billingPolicyApplies("claude-opus-5-5[1m]")).resolves.toBe(true);

    await ctx.createCombo({ name: "claude-opus-5-5", models: ["anthropic/claude-opus-5-5"] });
    await ctx.setModelAlias("opus", "anthropic/claude-opus-5-5");
    await expect(ctx.billingPolicyApplies("claude-opus-5-5")).resolves.toBe(false);
    await expect(ctx.billingPolicyApplies("opus")).resolves.toBe(false);
    await expect(ctx.billingPolicyApplies("grok-build", { "grok-build": "gcli/grok-build" })).resolves.toBe(false);
    await expect(ctx.billingPolicyApplies("anthropic/claude-opus-5-5")).resolves.toBe(false);
  });

  it("picks up alias and disabled-model edits without waiting out the cache", async () => {
    const ctx = await setup(["cc/m-4"], [{ provider: "claude" }]);
    await expect(ctx.getAutoComboModels("m-4")).resolves.toEqual(["cc/m-4"]);

    catalog.ids = [];
    const { disableModels } = await import("@/lib/db/repos/disabledModelsRepo.js");
    await disableModels("cc", ["m-4"]);
    await expect(ctx.getAutoComboModels("m-4")).resolves.toEqual([]);

    catalog.ids = ["cc/m-4"];
    await ctx.setModelAlias("m4", "cc/m-4");
    await expect(ctx.getAutoComboModels("m-4")).resolves.toEqual(["cc/m-4"]);
  });

  it("backs off after a timed-out build instead of starting another per request", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    try {
      const ctx = await setup(["cc/m-5"], [{ provider: "claude" }]);
      catalog.hang = true;
      catalog.builds = 0;
      await ctx.createProviderConnection({ provider: "kiro", authType: "oauth", name: "kiro-3", accessToken: "t", isActive: true });
      const first = ctx.getAutoComboModels("m-5");
      await vi.advanceTimersByTimeAsync(31_000);
      await first;
      expect(catalog.builds).toBe(1);
      // Timed out: the next requests serve the old list and start nothing new.
      await ctx.getAutoComboModels("m-5");
      await ctx.getAutoComboModels("m-5");
      expect(catalog.builds).toBe(1);
    } finally {
      catalog.hang = false;
      vi.useRealTimers();
    }
  });

  it("starts a fresh build when connections change mid-build", async () => {
    const ctx = await setup(["cc/m-6"], [{ provider: "claude" }]);
    catalog.hang = true;
    catalog.builds = 0;
    await ctx.createProviderConnection({ provider: "codex", authType: "oauth", name: "cx-1", accessToken: "t", isActive: true });
    void ctx.getAutoComboModels("m-6");
    await ctx.createProviderConnection({ provider: "kiro", authType: "oauth", name: "kr-1", accessToken: "t", isActive: true });
    catalog.hang = false;
    catalog.ids = ["cc/m-6", "kr/m-6"];
    await expect(ctx.getAutoComboModels("m-6")).resolves.toEqual(["kr/m-6", "cc/m-6"]);
    expect(catalog.builds).toBe(2);
  });

  describe("right after a restart (no list built yet)", () => {
    it("holds a bare id until the startup build lands, past the stale-list head start", async () => {
      const ctx = await setup(["cc/m-7"], [{ provider: "claude" }], null, { warm: false });
      const slow = deferred();
      catalog.gate = slow.promise;
      catalog.builds = 0;
      vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
      try {
        // instrumentation.js starts this build as the server boots.
        const warm = ctx.warmAutoComboCatalog();
        const pending = ctx.getAutoComboModels("m-7");
        const request = track(pending);
        await vi.advanceTimersByTimeAsync(10_000);
        // Answering now would route the bare id with no list: an unknown model.
        expect(request.settled).toBe(false);

        slow.resolve();
        await warm;
        await expect(pending).resolves.toEqual(["cc/m-7"]);
        expect(catalog.builds).toBe(1);
      } finally {
        catalog.gate = null;
        vi.useRealTimers();
      }
    });

    it("starts the build itself when no startup warmup ran, and waits for it", async () => {
      const ctx = await setup(["cc/m-8"], [{ provider: "claude" }], null, { warm: false });
      const slow = deferred();
      catalog.gate = slow.promise;
      catalog.builds = 0;
      vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
      try {
        const first = ctx.getAutoComboModels("m-8");
        const second = ctx.getAutoComboModels("m-8");
        const firstBox = track(first);
        const secondBox = track(second);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(firstBox.settled || secondBox.settled).toBe(false);

        slow.resolve();
        await expect(first).resolves.toEqual(["cc/m-8"]);
        await expect(second).resolves.toEqual(["cc/m-8"]);
        // Both requests shared one build.
        expect(catalog.builds).toBe(1);
      } finally {
        catalog.gate = null;
        vi.useRealTimers();
      }
    });

    it("stops waiting when the first build times out", async () => {
      const ctx = await setup(["cc/m-9"], [{ provider: "claude" }], null, { warm: false });
      catalog.hang = true;
      vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
      try {
        const pending = ctx.getAutoComboModels("m-9");
        const request = track(pending);
        await vi.advanceTimersByTimeAsync(29_000);
        expect(request.settled).toBe(false);
        await vi.advanceTimersByTimeAsync(2_000);
        await expect(pending).resolves.toEqual([]);
      } finally {
        catalog.hang = false;
        vi.useRealTimers();
      }
    });

    it("retries within seconds after the first build times out, so the next request still gets a list", async () => {
      const ctx = await setup(["cc/m-11"], [{ provider: "claude" }], null, { warm: false });
      // The first build outlives its refresh's 30 s, then fails.
      const failing = deferred();
      catalog.gates = [failing.promise.then(() => { throw new Error("upstream /models failed"); })];
      catalog.builds = 0;
      vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
      try {
        const first = ctx.getAutoComboModels("m-11");
        await vi.advanceTimersByTimeAsync(31_000);
        await expect(first).resolves.toEqual([]);
        failing.resolve();
        await vi.advanceTimersByTimeAsync(0);

        // The upstream answers again. A warm cache would back off a minute
        // here; a cold one must not leave requests with no list that long.
        const next = ctx.getAutoComboModels("m-11");
        const box = track(next);
        await vi.advanceTimersByTimeAsync(2_100);
        expect(box.settled).toBe(true);
        await expect(next).resolves.toEqual(["cc/m-11"]);
        expect(catalog.builds).toBe(2);
      } finally {
        catalog.gates = [];
        vi.useRealTimers();
      }
    });

    it("retries a first build that failed while the same request waits", async () => {
      const ctx = await setup(["cc/m-12"], [{ provider: "claude" }], null, { warm: false });
      catalog.fail = true;
      catalog.builds = 0;
      vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
      try {
        const pending = ctx.getAutoComboModels("m-12");
        const box = track(pending);
        await vi.advanceTimersByTimeAsync(100);
        expect(catalog.builds).toBe(1);
        expect(box.settled).toBe(false);

        catalog.fail = false;
        await vi.advanceTimersByTimeAsync(2_000);
        await expect(pending).resolves.toEqual(["cc/m-12"]);
        expect(catalog.builds).toBe(2);
      } finally {
        catalog.fail = false;
        vi.useRealTimers();
      }
    });

    it("stops waiting after three failed builds instead of holding the request for the whole wait", async () => {
      const ctx = await setup(["cc/m-17"], [{ provider: "claude" }], null, { warm: false });
      catalog.fail = true;
      catalog.builds = 0;
      vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
      try {
        const pending = ctx.getAutoComboModels("m-17");
        const box = track(pending);
        await vi.advanceTimersByTimeAsync(2_100);
        expect(catalog.builds).toBe(2);
        expect(box.settled).toBe(false);
        await vi.advanceTimersByTimeAsync(2_100);
        await expect(pending).resolves.toEqual([]);
        expect(catalog.builds).toBe(3);
      } finally {
        catalog.fail = false;
        vi.useRealTimers();
      }
    });

    it("doesn't count builds still running as failed, however often connections change", async () => {
      const ctx = await setup(["cc/m-18"], [{ provider: "claude" }], null, { warm: false });
      const first = deferred();
      // The startup build is slow; each build after a connection change hangs.
      catalog.gates = [first.promise, new Promise(() => {}), new Promise(() => {}), new Promise(() => {})];
      catalog.builds = 0;
      const warm = ctx.warmAutoComboCatalog();
      const pending = ctx.getAutoComboModels("m-18");
      for (const name of ["kiro-a", "kiro-b", "kiro-c"]) {
        await ctx.createProviderConnection({ provider: "kiro", authType: "oauth", name, accessToken: "t", isActive: true });
        // A request after each change starts a build for the new connections.
        void ctx.getAutoComboModels("m-18", undefined, { maxWaitMs: 1 });
      }
      const box = track(pending);
      await new Promise((r) => setTimeout(r, 50));
      expect(catalog.builds).toBe(4);
      expect(box.settled).toBe(false);

      first.resolve();
      await warm;
      await expect(pending).resolves.toEqual(["cc/m-18"]);
      catalog.gates = [];
    });

    it("joins the startup build still running after a refresh timed out, instead of starting another", async () => {
      const ctx = await setup(["cc/m-19"], [{ provider: "claude" }], null, { warm: false });
      const slow = deferred();
      catalog.gate = slow.promise;
      catalog.builds = 0;
      vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
      try {
        const first = ctx.getAutoComboModels("m-19");
        await vi.advanceTimersByTimeAsync(31_000);
        await expect(first).resolves.toEqual([]);

        // The retry 2 s later joins the same build: no second full build.
        const next = ctx.getAutoComboModels("m-19");
        await vi.advanceTimersByTimeAsync(3_000);
        expect(catalog.builds).toBe(1);

        slow.resolve();
        await expect(next).resolves.toEqual(["cc/m-19"]);
        expect(catalog.builds).toBe(1);
      } finally {
        catalog.gate = null;
        vi.useRealTimers();
      }
    });

    it("rebuilds a list where a live catalog timed out within 30 s, without waiting for a request", async () => {
      const ctx = await setup(["cc/m-20"], [{ provider: "claude" }, { provider: "kiro" }], null, { warm: false });
      // Kiro's live catalog timed out: the list has only its static models.
      catalog.timedOut = ["kr"];
      catalog.builds = 0;
      vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
      try {
        await ctx.warmAutoComboCatalog();
        await expect(ctx.getAutoComboModels("m-20")).resolves.toEqual(["cc/m-20"]);
        expect(catalog.builds).toBe(1);

        // Kiro answers now, with a per-account model.
        catalog.timedOut = [];
        catalog.ids = ["cc/m-20", "kr/m-20"];
        await vi.advanceTimersByTimeAsync(29_000);
        expect(catalog.builds).toBe(1);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(catalog.builds).toBe(2);
        await expect(ctx.getAutoComboModels("m-20")).resolves.toEqual(["kr/m-20", "cc/m-20"]);

        // A complete list is kept the usual 5 minutes: no rebuild at 30 s.
        await vi.advanceTimersByTimeAsync(60_000);
        expect(catalog.builds).toBe(2);
      } finally {
        catalog.timedOut = [];
        vi.useRealTimers();
      }
    });

    it("stops rebuilding early after a few partial lists in a row", async () => {
      const ctx = await setup(["cc/m-21"], [{ provider: "claude" }], null, { warm: false });
      catalog.timedOut = ["zed"];
      catalog.builds = 0;
      vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
      try {
        await ctx.warmAutoComboCatalog();
        // Three early rebuilds, then the usual TTL.
        await vi.advanceTimersByTimeAsync(31_000 * 4);
        expect(catalog.builds).toBe(4);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(catalog.builds).toBe(4);
      } finally {
        catalog.timedOut = [];
        vi.useRealTimers();
      }
    });

    it("keeps a warm list's models for providers whose live catalog timed out in a rebuild", async () => {
      const ctx = await setup(
        ["cc/m-22", "kr/m-22-thinking", "zd/m-22-zed"],
        [{ provider: "claude" }, { provider: "kiro" }, { provider: "zed" }],
      );
      await expect(ctx.getAutoComboModels("m-22-thinking")).resolves.toEqual(["kr/m-22-thinking"]);
      await expect(ctx.getAutoComboModels("m-22-zed")).resolves.toEqual(["zd/m-22-zed"]);

      // A routine rebuild where Zed's and Kiro's live catalogs time out: Zed has
      // no static models, and Kiro's static list lacks the per-account variant.
      // Claude answered, with a new model.
      catalog.timedOut = ["kr", "zd"];
      catalog.ids = ["cc/m-22", "cc/m-22-new", "kr/m-22"];
      try {
        await ctx.warmAutoComboCatalog();
        await expect(ctx.getAutoComboModels("m-22-thinking")).resolves.toEqual(["kr/m-22-thinking"]);
        await expect(ctx.getAutoComboModels("m-22-zed")).resolves.toEqual(["zd/m-22-zed"]);
        await expect(ctx.getAutoComboModels("m-22-new")).resolves.toEqual(["cc/m-22-new"]);
        // Kiro's static stand-in doesn't replace what it had.
        await expect(ctx.getAutoComboModels("m-22")).resolves.toEqual(["cc/m-22"]);
      } finally {
        catalog.timedOut = [];
      }
    });

    it("serves the first list that lands, even when a connection change started a newer build", async () => {
      const ctx = await setup(["cc/m-13"], [{ provider: "claude" }], null, { warm: false });
      const first = deferred();
      // The startup build waits on `first`; the newer one, for the changed
      // connections, never finishes.
      catalog.gates = [first.promise, new Promise(() => {})];
      catalog.builds = 0;
      const warm = ctx.warmAutoComboCatalog();
      await ctx.createProviderConnection({ provider: "kiro", authType: "oauth", name: "kiro-cold", accessToken: "t", isActive: true });
      vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
      try {
        const pending = ctx.getAutoComboModels("m-13");
        await vi.advanceTimersByTimeAsync(100);
        expect(catalog.builds).toBe(2);

        first.resolve();
        await warm;
        await expect(pending).resolves.toEqual(["cc/m-13"]);
      } finally {
        catalog.gates = [];
        vi.useRealTimers();
      }
    });

    it("stops waiting when the client hangs up", async () => {
      const ctx = await setup(["cc/m-14"], [{ provider: "claude" }], null, { warm: false });
      catalog.hang = true;
      vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
      try {
        const controller = new AbortController();
        const pending = ctx.getAutoComboModels("m-14", undefined, { signal: controller.signal });
        const box = track(pending);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(box.settled).toBe(false);

        controller.abort();
        await expect(pending).resolves.toEqual([]);
      } finally {
        catalog.hang = false;
        vi.useRealTimers();
      }
    });

    it("caps the wait at maxWaitMs", async () => {
      const ctx = await setup(["cc/m-15"], [{ provider: "claude" }], null, { warm: false });
      catalog.hang = true;
      vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
      try {
        const pending = ctx.getAutoComboModels("m-15", undefined, { maxWaitMs: 5_000 });
        const box = track(pending);
        await vi.advanceTimersByTimeAsync(4_900);
        expect(box.settled).toBe(false);
        await vi.advanceTimersByTimeAsync(200);
        await expect(pending).resolves.toEqual([]);
      } finally {
        catalog.hang = false;
        vi.useRealTimers();
      }
    });

    it("answers a user alias or combo at once, without waiting for (or starting) a build", async () => {
      const ctx = await setup(["cc/m-16"], [{ provider: "claude" }], null, { warm: false });
      await ctx.setModelAlias("fast", "cc/m-16");
      await ctx.createCombo({ name: "team", models: ["cc/m-16"] });
      catalog.hang = true;
      catalog.builds = 0;
      vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
      try {
        // No timers advance: anything that waited on the catalog would hang.
        await expect(ctx.resolveAutoCombo("fast")).resolves.toBeNull();
        await expect(ctx.resolveAutoCombo("team")).resolves.toBeNull();
        expect(catalog.builds).toBe(0);
      } finally {
        catalog.hang = false;
        vi.useRealTimers();
      }
    });
  });

  describe("sanitizeAutoComboSetting", () => {
    it("accepts known billing sets and rejects anything else", async () => {
      const { sanitizeAutoComboSetting } = await import("@/sse/services/autoCombo.ts");
      expect(sanitizeAutoComboSetting("autoComboBlockedBilling", ["payg", "payg", " custom "])).toEqual(["payg", "custom"]);
      expect(sanitizeAutoComboSetting("autoComboBlockedBilling", ["paid"])).toBeNull();
      expect(sanitizeAutoComboSetting("autoComboBlockedBilling", "payg")).toBeNull();
      expect(sanitizeAutoComboSetting("autoComboExcludedProviders", ["cc", 3])).toBeNull();
      expect(sanitizeAutoComboSetting("autoComboExcludedProviders", [" cc ", ""])).toEqual(["cc"]);
    });
  });
});
