import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";

// Anthropic clients append a context-window selector to the model id
// ("claude-opus-5[1m]"). Combos are stored under the bare name and looked up by
// exact SQL match, so the selector has to come off before the lookup. It bit in
// production: getModelInfo() strips the suffix, finds the combo and reports
// provider:null, but the handler's own getComboModels(modelStr) call still used
// the raw id, matched nothing, and the request died as "Invalid model format".
const originalDataDir = process.env.DATA_DIR;
const COMBO_NAME = "claude-opus-5";
const COMBO_MODELS = ["cc/claude-opus-5", "tokenrouter/anthropic/claude-opus-5"];

async function setupDb() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-combo-suffix-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();

  const { createCombo, getComboByName } = await import("@/models/index.js");
  const { getComboModels, comboLookupName, getModelInfo } = await import("@/sse/services/model.js");

  // The sqlite adapter holds its connection across vi.resetModules(), so the
  // combo can outlive a single setup call. Create it only when it is missing.
  if (!(await getComboByName(COMBO_NAME))) {
    await createCombo({ name: COMBO_NAME, models: COMBO_MODELS });
  }

  return {
    getComboModels,
    comboLookupName,
    getModelInfo,
    cleanup() {
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

describe("combo lookup with a context-window selector", () => {
  let cleanup = () => {};

  afterEach(() => {
    cleanup();
    cleanup = () => {};
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("resolves a combo requested with a [1m] selector", async () => {
    const ctx = await setupDb();
    cleanup = ctx.cleanup;

    await expect(ctx.getComboModels("claude-opus-5[1m]")).resolves.toEqual([
      "cc/claude-opus-5",
      "tokenrouter/anthropic/claude-opus-5",
    ]);
  });

  it("resolves the same combo without a selector", async () => {
    const ctx = await setupDb();
    cleanup = ctx.cleanup;

    await expect(ctx.getComboModels("claude-opus-5")).resolves.toEqual([
      "cc/claude-opus-5",
      "tokenrouter/anthropic/claude-opus-5",
    ]);
  });

  it("still reports a combo as provider-less so the handler routes it", async () => {
    const ctx = await setupDb();
    cleanup = ctx.cleanup;

    await expect(ctx.getModelInfo("claude-opus-5[1m]")).resolves.toMatchObject({
      provider: null,
      model: "claude-opus-5",
    });
  });

  it("does not invent a combo for an unknown name", async () => {
    const ctx = await setupDb();
    cleanup = ctx.cleanup;

    await expect(ctx.getComboModels("not-a-combo[1m]")).resolves.toBeNull();
  });

  it("leaves provider-prefixed ids out of combo lookup entirely", async () => {
    const ctx = await setupDb();
    cleanup = ctx.cleanup;

    await expect(ctx.getComboModels("cc/claude-opus-5[1m]")).resolves.toBeNull();
  });

  describe("comboLookupName", () => {
    it("normalizes a selector to the stored combo name", async () => {
      const ctx = await setupDb();
      cleanup = ctx.cleanup;

      expect(ctx.comboLookupName("claude-opus-5[1m]")).toBe("claude-opus-5");
      expect(ctx.comboLookupName("claude-opus-5")).toBe("claude-opus-5");
    });
  });
});
