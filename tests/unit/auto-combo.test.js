// A bare model id with no combo behind it falls back across every connected
// provider that serves it, so clients like Claude Code need no hand-made combo.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// /v1/models lists models under each connection's output prefix; the test
// controls that list directly and connects whichever providers it names.
const catalog = vi.hoisted(() => ({ ids: [], hang: false, builds: 0 }));
vi.mock("@/app/api/v1/models/route.js", () => ({
  buildModelsList: async () => {
    catalog.builds++;
    if (catalog.hang) await new Promise(() => {});
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

// conns: [{ provider, authType?, prefix? }]
async function setup(ids, conns = [], settings = null) {
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
  await auto.warmAutoComboCatalog();
  return { ...db, ...auto };
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

  describe("failing providers", () => {
    const IDS = ["cc/m-7", "kr/m-7"];
    const kiroId = async (ctx) => (await ctx.getProviderConnections({ provider: "kiro" }))[0].id;

    it("keeps the billing order when nothing is failing", async () => {
      const ctx = await setup(IDS, SUBS);
      await expect(ctx.getAutoComboModels("m-7")).resolves.toEqual(["kr/m-7", "cc/m-7"]);
    });

    it("moves a provider whose key is rejected behind healthy ones, even after its lock expires", async () => {
      const ctx = await setup(IDS, SUBS);
      const { markAccountUnavailable } = await import("@/sse/services/auth.js");
      await markAccountUnavailable(await kiroId(ctx), 401, "Incorrect API key", "kiro", "m-7");
      await expect(ctx.getAutoComboModels("m-7")).resolves.toEqual(["cc/m-7", "kr/m-7"]);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(Date.now() + 10 * 60_000);
        await expect(ctx.getAutoComboModels("m-7")).resolves.toEqual(["cc/m-7", "kr/m-7"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps a failing provider as the last resort", async () => {
      const ctx = await setup(["kr/m-8"], SUBS);
      const { markAccountUnavailable } = await import("@/sse/services/auth.js");
      await markAccountUnavailable(await kiroId(ctx), 403, "forbidden", "kiro", "m-8");
      await expect(ctx.getAutoComboModels("m-8")).resolves.toEqual(["kr/m-8"]);
    });

    it("demotes a provider locked for this model only while the lock lasts", async () => {
      const ctx = await setup(IDS, SUBS);
      const { markAccountUnavailable } = await import("@/sse/services/auth.js");
      await markAccountUnavailable(await kiroId(ctx), 429, "rate limit", "kiro", "m-7");
      await expect(ctx.getAutoComboModels("m-7")).resolves.toEqual(["cc/m-7", "kr/m-7"]);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(Date.now() + 60 * 60_000);
        await expect(ctx.getAutoComboModels("m-7")).resolves.toEqual(["kr/m-7", "cc/m-7"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps a provider in place while one of its accounts still works", async () => {
      const ctx = await setup(IDS, [...SUBS, { provider: "kiro" }]);
      const { markAccountUnavailable } = await import("@/sse/services/auth.js");
      await markAccountUnavailable(await kiroId(ctx), 401, "Incorrect API key", "kiro", "m-7");
      await expect(ctx.getAutoComboModels("m-7")).resolves.toEqual(["kr/m-7", "cc/m-7"]);
    });

    it("returns to the normal order once the provider succeeds again", async () => {
      const ctx = await setup(IDS, SUBS);
      const { markAccountUnavailable, clearAccountError } = await import("@/sse/services/auth.js");
      const id = await kiroId(ctx);
      await markAccountUnavailable(id, 401, "Incorrect API key", "kiro", "m-7");
      await expect(ctx.getAutoComboModels("m-7")).resolves.toEqual(["cc/m-7", "kr/m-7"]);

      const conn = (await ctx.getProviderConnections({ provider: "kiro" }))[0];
      await clearAccountError(id, conn, "m-7");
      await expect(ctx.getAutoComboModels("m-7")).resolves.toEqual(["kr/m-7", "cc/m-7"]);
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
