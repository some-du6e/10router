import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let dataDir;

// A fresh module graph, as a second route bundle or process would load it.
async function loadAuthSecret() {
  vi.resetModules();
  return import("../../src/lib/auth/authSecret.js");
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "10r-auth-secret-"));
  vi.stubEnv("DATA_DIR", dataDir);
  vi.stubEnv("JWT_SECRET", "");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("server auth secret", () => {
  it("prefers JWT_SECRET", async () => {
    vi.stubEnv("JWT_SECRET", "from-env");
    const { getAuthSecret } = await loadAuthSecret();
    expect(getAuthSecret()).toBe("from-env");
    expect(fs.existsSync(path.join(dataDir, "jwt-secret"))).toBe(false);
  });

  it("generates one owner-only secret file that every module graph then shares", async () => {
    const first = (await loadAuthSecret()).getAuthSecret();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    const file = path.join(dataDir, "jwt-secret");
    expect(fs.readFileSync(file, "utf8")).toBe(first);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect((await loadAuthSecret()).getAuthSecret()).toBe(first);
  });

  it("uses the secret another graph wrote first instead of overwriting it", async () => {
    const { getAuthSecret } = await loadAuthSecret();
    const file = path.join(dataDir, "jwt-secret");
    // Both looked before either wrote: this graph saw no file, then the other one created it.
    const realRead = fs.readFileSync;
    let reads = 0;
    vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
      if (args[0] === file && reads++ === 0) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return realRead.apply(fs, args);
    });
    fs.writeFileSync(file, "winner-secret");
    expect(getAuthSecret()).toBe("winner-secret");
    expect(realRead.call(fs, file, "utf8")).toBe("winner-secret");
    expect(fs.readdirSync(dataDir)).toEqual(["jwt-secret"]);
  });

  it("leaves only the secret file behind, never a temp file", async () => {
    (await loadAuthSecret()).getAuthSecret();
    expect(fs.readdirSync(dataDir)).toEqual(["jwt-secret"]);
  });

  it("falls back to an exclusive copy where hard links aren't supported", async () => {
    const { getAuthSecret } = await loadAuthSecret();
    vi.spyOn(fs, "linkSync").mockImplementation(() => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    });
    const secret = getAuthSecret();
    const file = path.join(dataDir, "jwt-secret");
    expect(fs.readFileSync(file, "utf8")).toBe(secret);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dataDir)).toEqual(["jwt-secret"]);
  });

  it("refuses an empty secret file rather than signing with an empty key", async () => {
    fs.writeFileSync(path.join(dataDir, "jwt-secret"), "");
    const { getAuthSecret } = await loadAuthSecret();
    expect(() => getAuthSecret()).toThrow(/is empty/);
    // Left as it is for the operator: the error says how to fix it.
    expect(fs.readFileSync(path.join(dataDir, "jwt-secret"), "utf8")).toBe("");
  });
});
