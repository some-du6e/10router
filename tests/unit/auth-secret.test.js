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

  it("never writes the secret file in place: it links a temp file that already holds the whole secret", async () => {
    const { getAuthSecret } = await loadAuthSecret();
    const file = path.join(dataDir, "jwt-secret");
    const written = [];
    const realWrite = fs.writeFileSync;
    const realOpen = fs.openSync;
    const realLink = fs.linkSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation((target, ...rest) => {
      written.push(String(target));
      return realWrite.call(fs, target, ...rest);
    });
    vi.spyOn(fs, "openSync").mockImplementation((target, flags, ...rest) => {
      // readFileSync opens with "r"; anything else can write.
      if (flags !== undefined && flags !== "r" && flags !== fs.constants.O_RDONLY) written.push(String(target));
      return realOpen.call(fs, target, flags, ...rest);
    });
    let linkedContent = null;
    vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
      expect(to).toBe(file);
      linkedContent = fs.readFileSync(from, "utf8");
      return realLink.call(fs, from, to);
    });

    const secret = getAuthSecret();
    expect(written).not.toContain(file);
    expect(linkedContent).toMatch(/^[0-9a-f]{64}$/);
    expect(linkedContent).toBe(secret);
  });

  it.each(["EPERM", "EISDIR", "EINVAL"])("falls back to an exclusive copy when linking fails with %s", async (code) => {
    const { getAuthSecret } = await loadAuthSecret();
    vi.spyOn(fs, "linkSync").mockImplementation(() => {
      throw Object.assign(new Error(code), { code });
    });
    const secret = getAuthSecret();
    const file = path.join(dataDir, "jwt-secret");
    expect(fs.readFileSync(file, "utf8")).toBe(secret);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dataDir)).toEqual(["jwt-secret"]);
  });

  it("waits briefly for a just-created empty file to get its bytes", async () => {
    const file = path.join(dataDir, "jwt-secret");
    fs.writeFileSync(file, "");
    const { getAuthSecret } = await loadAuthSecret();
    // The writer lands its bytes while this reader waits.
    const realRead = fs.readFileSync;
    const realWrite = fs.writeFileSync.bind(fs);
    let reads = 0;
    vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
      if (args[0] === file && ++reads === 3) realWrite(file, "late-secret");
      return realRead.apply(fs, args);
    });
    expect(getAuthSecret()).toBe("late-secret");
  });

  it("refuses an empty secret file rather than signing with an empty key", async () => {
    const file = path.join(dataDir, "jwt-secret");
    fs.writeFileSync(file, "");
    // Old enough that no writer can still be filling it.
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(file, old, old);
    const { getAuthSecret } = await loadAuthSecret();
    expect(() => getAuthSecret()).toThrow(/is empty/);
    // Left as it is for the operator: the error says how to fix it.
    expect(fs.readFileSync(path.join(dataDir, "jwt-secret"), "utf8")).toBe("");
  });
});
