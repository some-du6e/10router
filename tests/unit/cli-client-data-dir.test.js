import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

describe("CLI API client data directory", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reads the token secret from the same directory the server writes it to", async () => {
    vi.stubEnv("DATA_DIR", "");
    const { getDataDir: serverDataDir } = await import("../../src/lib/dataDir.js");
    const { getDataDir: clientDataDir } = require("../../cli/src/cli/api/client.js");
    expect(clientDataDir()).toBe(serverDataDir());
  });
});
