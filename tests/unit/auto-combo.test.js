import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";

// A bare model id with no combo behind it falls back across every connected
// provider that serves it, so clients like Claude Code need no hand-made combo.
const catalog = vi.hoisted(() => ({ ids: [] }));
vi.mock("@/app/api/v1/models/route.js", () => ({
  buildModelsList: async () => catalog.ids.map((id) => ({ id, object: "model", owned_by: id.split("/")[0] })),
}));

const originalDataDir = process.env.DATA_DIR;

async function setup(ids) {
  catalog.ids = ids;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-auto-combo-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  const db = { ...(await import("@/models/index.js")), ...(await import("@/lib/localDb.js")) };
  if (ids.length && !(await db.getProviderConnections()).length) {
    await db.createProviderConnection({ provider: "claude", authType: "apikey", name: "test", apiKey: "k" });
  }
  const model = await import("@/sse/services/model.js");
  return { ...db, ...model, cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }) };
}

describe("auto combos", () => {
  let cleanup = () => {};
  afterEach(() => {
    cleanup();
    cleanup = () => {};
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("falls back across every provider serving a bare model id", async () => {
    const ctx = await setup(["sfff/claude-opus-5-5", "cc/claude-opus-5.5", "or/anthropic/claude-opus-5-5", "cc/claude-sonnet-5-5"]);
    cleanup = ctx.cleanup;

    await expect(ctx.getComboModels("claude-opus-5-5[1m]")).resolves.toEqual([
      "sfff/claude-opus-5-5",
      "cc/claude-opus-5.5",
      "or/anthropic/claude-opus-5-5",
    ]);
    await expect(ctx.getModelInfo("claude-opus-5-5")).resolves.toMatchObject({ provider: null });
  });

  it("routes straight to the only provider serving the model", async () => {
    const ctx = await setup(["sfff/claude-haiku-5-5", "cc/claude-opus-5-5"]);
    cleanup = ctx.cleanup;

    await expect(ctx.getComboModels("claude-haiku-5-5")).resolves.toBeNull();
    const info = await ctx.getModelInfo("claude-haiku-5-5");
    expect(info.provider).toBeTruthy();
    expect(info.model).toBe("claude-haiku-5-5");
  });

  it("leaves a hand-made combo and an alias in charge", async () => {
    const ctx = await setup(["sfff/claude-opus-5-5", "cc/claude-opus-5-5"]);
    cleanup = ctx.cleanup;
    if (!(await ctx.getComboByName("claude-opus-5-5"))) {
      await ctx.createCombo({ name: "claude-opus-5-5", models: ["cc/claude-opus-5-5"] });
    }
    await ctx.setModelAlias("opus", "cc/claude-opus-5-5");

    await expect(ctx.getComboModels("claude-opus-5-5")).resolves.toEqual(["cc/claude-opus-5-5"]);
    await expect(ctx.getComboModels("opus")).resolves.toBeNull();
  });

  it("skips excluded providers", async () => {
    const ctx = await setup(["paid/claude-sonnet-5-5", "free/claude-sonnet-5-5", "cheap/claude-sonnet-5-5"]);
    cleanup = ctx.cleanup;
    await ctx.updateSettings({ autoComboExcludedProviders: ["paid"] });

    await expect(ctx.getComboModels("claude-sonnet-5-5")).resolves.toEqual([
      "free/claude-sonnet-5-5",
      "cheap/claude-sonnet-5-5",
    ]);
    await ctx.updateSettings({ autoComboExcludedProviders: [] });
  });

  it("blocks pay-per-token and free-tier providers unless allowed", async () => {
    // openai = pay per token, openrouter = free tier, cc = subscription, kr = free
    const ids = ["openai/gpt-9", "openrouter/openai/gpt-9", "cx/gpt-9", "kr/gpt-9"];
    const ctx = await setup(ids);
    cleanup = ctx.cleanup;

    await expect(ctx.getComboModels("gpt-9")).resolves.toEqual(["cx/gpt-9", "kr/gpt-9"]);

    await ctx.updateSettings({ autoComboBlockedBilling: ["subscription"] });
    await expect(ctx.getComboModels("gpt-9")).resolves.toEqual([
      "openai/gpt-9",
      "openrouter/openai/gpt-9",
      "kr/gpt-9",
    ]);
    await ctx.updateSettings({ autoComboBlockedBilling: ["payg", "freeTier"] });
  });

  it("does nothing when no provider is connected", async () => {
    const ctx = await setup([]);
    cleanup = ctx.cleanup;
    catalog.ids = ["sfff/claude-fable-5-1", "cc/claude-fable-5-1"];
    for (const c of await ctx.getProviderConnections()) await ctx.deleteProviderConnection(c.id);

    await expect(ctx.getComboModels("claude-fable-5-1")).resolves.toBeNull();
  });

  it("ignores unknown and provider-prefixed ids", async () => {
    const ctx = await setup(["sfff/claude-opus-5-5", "cc/claude-opus-5-5"]);
    cleanup = ctx.cleanup;

    await expect(ctx.getComboModels("nope-1")).resolves.toBeNull();
    await expect(ctx.getComboModels("cc/claude-opus-5-5")).resolves.toBeNull();
  });
});
