import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import os from "node:os";

const require = createRequire(import.meta.url);
const realPlatform = process.platform;

async function bothDataDirs() {
  const { getDataDir: serverDataDir } = await import("../../src/lib/dataDir.js");
  const { getDataDir: clientDataDir } = require("../../cli/src/cli/api/client.js");
  return { client: clientDataDir(), server: serverDataDir() };
}

describe("CLI API client data directory", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    Object.defineProperty(process, "platform", { value: realPlatform });
  });

  it("reads the token secret from the same directory the server writes it to", async () => {
    vi.stubEnv("DATA_DIR", "");
    const { client, server } = await bothDataDirs();
    expect(client).toBe(server);
  });

  it("uses the server's APPDATA directory on Windows", async () => {
    vi.stubEnv("DATA_DIR", "");
    vi.stubEnv("APPDATA", os.tmpdir());
    Object.defineProperty(process, "platform", { value: "win32" });
    const { client, server } = await bothDataDirs();
    expect(client).toBe(server);
  });

  it("follows DATA_DIR like the server", async () => {
    vi.stubEnv("DATA_DIR", os.tmpdir());
    const { client, server } = await bothDataDirs();
    expect(client).toBe(os.tmpdir());
    expect(client).toBe(server);
  });
});
