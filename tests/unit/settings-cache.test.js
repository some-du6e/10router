import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-settings-cache-"));
process.env.DATA_DIR = dataDir;
vi.resetModules();

const { getSettings, updateSettings } = await import("../../src/lib/db/index.js");
const { getAdapter } = await import("../../src/lib/db/driver.js");

// Write straight to the row, bypassing updateSettings and its invalidation.
async function writeRawSettings(data) {
  const db = await getAdapter();
  db.run(
    `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
    [JSON.stringify(data)],
  );
}

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("cached getSettings", () => {
  it("sees an update immediately", async () => {
    await getSettings();
    await updateSettings({ requireApiKey: true });
    expect((await getSettings()).requireApiKey).toBe(true);
    await updateSettings({ requireApiKey: false });
    expect((await getSettings()).requireApiKey).toBe(false);
  });

  it("does not let a caller's mutation leak into the cache", async () => {
    const first = await getSettings();
    first.requireApiKey = "tampered";
    expect((await getSettings()).requireApiKey).not.toBe("tampered");
  });

  it("does not let a caller's nested mutation leak into the cache", async () => {
    await updateSettings({ providerStrategies: { openai: { fallbackStrategy: "fill-first" } } });
    // The first read fills the cache; the second is a cache hit. Tamper with both.
    for (const copy of [await getSettings(), await getSettings()]) {
      copy.providerStrategies.openai.fallbackStrategy = "tampered";
      copy.capacityAdapter.vision.models.push("tampered");
    }
    const fresh = await getSettings();
    expect(fresh.providerStrategies.openai.fallbackStrategy).toBe("fill-first");
    expect(fresh.capacityAdapter.vision.models).not.toContain("tampered");
  });

  it("serves from cache within the TTL and re-reads after it expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await updateSettings({ requireApiKey: false });
    expect((await getSettings()).requireApiKey).toBe(false);

    await writeRawSettings({ requireApiKey: true });
    vi.advanceTimersByTime(4000);
    expect((await getSettings()).requireApiKey).toBe(false);

    vi.advanceTimersByTime(1500);
    expect((await getSettings()).requireApiKey).toBe(true);
  });

  it("does not let a read started before an update cache stale settings", async () => {
    await updateSettings({ requireApiKey: false });
    const inFlight = getSettings();
    await updateSettings({ requireApiKey: true });
    await inFlight;
    expect((await getSettings()).requireApiKey).toBe(true);
  });
});
