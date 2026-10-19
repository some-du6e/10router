import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-settings-cache-"));
process.env.DATA_DIR = dataDir;
vi.resetModules();

const { getSettings, updateSettings } = await import("../../src/lib/db/index.js");

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

  it("does not let a read started before an update cache stale settings", async () => {
    await updateSettings({ requireApiKey: false });
    const inFlight = getSettings();
    await updateSettings({ requireApiKey: true });
    await inFlight;
    expect((await getSettings()).requireApiKey).toBe(true);
  });
});
