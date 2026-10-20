import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-pricing-cache-"));
process.env.DATA_DIR = dataDir;
vi.resetModules();

const { getPricing, getPricingForModel, updatePricing, resetAllPricing } =
  await import("../../src/lib/db/index.js");
const { PROVIDER_PRICING } = await import("open-sse/providers/pricing.js");

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const [provider, models] = Object.entries(PROVIDER_PRICING).find(([, m]) => Object.keys(m).length);
const model = Object.keys(models)[0];

describe("cached pricing lookups", () => {
  it("returns a partial user override as stored, not merged over the default", async () => {
    await resetAllPricing();
    await updatePricing({ [provider]: { [model]: { input: 123 } } });

    expect(await getPricingForModel(provider, model)).toEqual({ input: 123 });
    // The merged map still fills in the defaults for display.
    expect((await getPricing())[provider][model]).toMatchObject({ ...models[model], input: 123 });
  });

  it("sees a pricing update immediately", async () => {
    await resetAllPricing();
    await getPricingForModel(provider, model);
    await updatePricing({ [provider]: { [model]: { input: 1, output: 2 } } });
    expect(await getPricingForModel(provider, model)).toEqual({ input: 1, output: 2 });
  });

  it("does not let a read started before an update cache stale pricing", async () => {
    await resetAllPricing();
    await updatePricing({ [provider]: { [model]: { input: 1, output: 1 } } });
    const inFlight = getPricing();
    await updatePricing({ [provider]: { [model]: { input: 9, output: 9 } } });
    await inFlight;
    expect(await getPricingForModel(provider, model)).toEqual({ input: 9, output: 9 });
  });
});
