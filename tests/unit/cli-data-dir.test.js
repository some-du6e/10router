import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// cli/hooks/dataDir.js is the CLI's copy of src/lib/dataDir.js (the server's
// is ESM and bundled, so the CLI can't load it). They must agree everywhere.
const require = createRequire(import.meta.url);
const cliHelper = require("../../cli/hooks/dataDir.js");
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

let tmp;
let server;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-data-dir-"));
  vi.stubEnv("DATA_DIR", "");
  server = await import("../../src/lib/dataDir.js");
  vi.unstubAllEnvs();
});

afterEach(() => {
  Object.defineProperty(process, "platform", platformDescriptor);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function setPlatform(value) {
  Object.defineProperty(process, "platform", { ...platformDescriptor, value });
}

function bothDirs() {
  const client = cliHelper.getDataDir();
  expect(client).toBe(server.getDataDir());
  return client;
}

describe("CLI data directory helper", () => {
  it("defaults to ~/.9router", () => {
    vi.stubEnv("HOME", path.join(tmp, "home"));
    vi.stubEnv("DATA_DIR", "");
    expect(bothDirs()).toBe(path.join(tmp, "home", ".9router"));
  });

  it("uses APPDATA/9router on Windows", () => {
    setPlatform("win32");
    vi.stubEnv("DATA_DIR", "");
    vi.stubEnv("APPDATA", path.join(tmp, "appdata"));
    expect(bothDirs()).toBe(path.join(tmp, "appdata", "9router"));
  });

  it("falls back to the home directory's AppData/Roaming on Windows without APPDATA", () => {
    setPlatform("win32");
    vi.stubEnv("HOME", path.join(tmp, "home"));
    vi.stubEnv("DATA_DIR", "");
    vi.stubEnv("APPDATA", undefined);
    expect(bothDirs()).toBe(path.join(tmp, "home", "AppData", "Roaming", "9router"));
  });

  it("uses an absolute DATA_DIR", () => {
    const dir = path.join(tmp, "data");
    vi.stubEnv("DATA_DIR", dir);
    expect(bothDirs()).toBe(dir);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("ignores a Unix-style DATA_DIR on Windows", () => {
    setPlatform("win32");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // Writable, so only the Windows rule (not a failed mkdir) can reject it.
    const dir = path.join(tmp, "unix");
    expect(dir.startsWith("/")).toBe(true);
    vi.stubEnv("DATA_DIR", dir);
    vi.stubEnv("APPDATA", path.join(tmp, "appdata"));
    expect(bothDirs()).toBe(path.join(tmp, "appdata", "9router"));
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("falls back to the default when DATA_DIR can't be created", () => {
    const denied = path.join(tmp, "denied");
    const mkdirSync = fs.mkdirSync;
    vi.spyOn(fs, "mkdirSync").mockImplementation((dir, ...rest) => {
      if (dir === denied) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      return mkdirSync(dir, ...rest);
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("HOME", path.join(tmp, "home"));
    vi.stubEnv("DATA_DIR", denied);
    expect(bothDirs()).toBe(path.join(tmp, "home", ".9router"));
  });
});

describe("CLI DATA_DIR resolution", () => {
  it("makes a relative DATA_DIR absolute against the shell's directory", () => {
    expect(cliHelper.absoluteDataDir("data", path.join(tmp, "shell"))).toBe(path.join(tmp, "shell", "data"));
  });

  it("expands a leading ~/", () => {
    vi.stubEnv("HOME", path.join(tmp, "home"));
    expect(cliHelper.absoluteDataDir("~/data", "/elsewhere")).toBe(path.join(tmp, "home", "data"));
  });

  it("leaves a Unix-style path on Windows for the server to ignore", () => {
    setPlatform("win32");
    // Resolve the way Windows would, where "/x" becomes "C:\x".
    vi.spyOn(path, "resolve").mockImplementation(path.win32.resolve);
    expect(cliHelper.absoluteDataDir("/var/lib/placeholder", "C:\\elsewhere")).toBe("/var/lib/placeholder");
  });

  it("rewrites DATA_DIR in the env against INIT_CWD when npm set it", () => {
    const env = { DATA_DIR: "data", INIT_CWD: path.join(tmp, "shell") };
    cliHelper.normalizeDataDirEnv(env, undefined);
    expect(env.DATA_DIR).toBe(path.join(tmp, "shell", "data"));
  });

  it("rewrites DATA_DIR in the env against the given directory", () => {
    vi.stubEnv("HOME", path.join(tmp, "home"));
    const relative = { DATA_DIR: "data" };
    cliHelper.normalizeDataDirEnv(relative, path.join(tmp, "shell"));
    expect(relative.DATA_DIR).toBe(path.join(tmp, "shell", "data"));
    const tilde = { DATA_DIR: "~/data" };
    cliHelper.normalizeDataDirEnv(tilde, path.join(tmp, "shell"));
    expect(tilde.DATA_DIR).toBe(path.join(tmp, "home", "data"));
  });

  it("leaves an unset DATA_DIR unset", () => {
    const env = { INIT_CWD: path.join(tmp, "shell") };
    cliHelper.normalizeDataDirEnv(env);
    expect("DATA_DIR" in env).toBe(false);
  });
});
