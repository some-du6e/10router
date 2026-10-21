// A bare model id with no combo behind it falls back across every connected
// provider that serves it, so clients like Claude Code need no hand-made combo.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// /v1/models lists models under each connection's output prefix; the test
// controls that list directly and connects whichever providers it names.
const catalog = vi.hoisted(() => ({ ids: [] }));
vi.mock("@/app/api/v1/models/route.js", () => ({
  buildModelsList: async () => catalog.ids.map((id) => ({ id, object: "model", owned_by: id.split("/")[0] })),
}));

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-auto-combo-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  delete global._settingsCache;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  delete global._settingsCache;
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
  it("falls back across every unblocked provider serving a bare id", async () => {
    const ctx = await setup(
      ["cc/claude-opus-5-5", "kr/claude-opus-5.5", "cx/gpt-9", "cc/claude-sonnet-5-5"],
      SUBS,
    );

    await expect(ctx.resolveAutoCombo("claude-opus-5-5[1m]")).resolves.toEqual([
      "cc/claude-opus-5-5",
      "kr/claude-opus-5.5",
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

    await expect(ctx.getAutoComboModels("gpt-9")).resolves.toEqual(["cx/gpt-9", "kr/gpt-9"]);

    await ctx.updateSettings({ autoComboBlockedBilling: ["subscription"] });
    await expect(ctx.getAutoComboModels("gpt-9")).resolves.toEqual([
      "openai/gpt-9",
      "openrouter/openai/gpt-9",
      "mine/gpt-9",
      "kr/gpt-9",
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

    await expect(ctx.getAutoComboModels("m-1")).resolves.toEqual(["cc/m-1", "kr/m-1"]);
  });

  it("does nothing when no provider is connected", async () => {
    const ctx = await setup(["cc/claude-fable-5-1", "kr/claude-fable-5-1"]);

    await expect(ctx.resolveAutoCombo("claude-fable-5-1")).resolves.toBeNull();
  });

  it("picks up a new connection without waiting out the cache", async () => {
    const ctx = await setup(["cc/m-2", "kr/m-2"], [{ provider: "claude" }]);
    await expect(ctx.getAutoComboModels("m-2")).resolves.toEqual(["cc/m-2"]);

    await ctx.createProviderConnection({ provider: "kiro", authType: "oauth", name: "kiro-test", accessToken: "t", isActive: true });
    await expect(ctx.getAutoComboModels("m-2")).resolves.toEqual(["cc/m-2", "kr/m-2"]);
  });

  it("ignores unknown and provider-prefixed ids", async () => {
    const ctx = await setup(["cc/claude-opus-5-5", "kr/claude-opus-5-5"], SUBS);

    await expect(ctx.resolveAutoCombo("nope-1")).resolves.toBeNull();
    await expect(ctx.resolveAutoCombo("cc/claude-opus-5-5")).resolves.toBeNull();
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
