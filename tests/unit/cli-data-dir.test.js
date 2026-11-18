import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createRequire, Module } from "node:module";
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

  it("resolves against the process's own directory by default, not INIT_CWD", () => {
    // npm sets INIT_CWD for everything under `npm run`, including a CLI
    // started from a subdirectory, so it must not win at runtime.
    const env = { DATA_DIR: "data", INIT_CWD: path.join(tmp, "npm-root") };
    cliHelper.normalizeDataDirEnv(env);
    expect(env.DATA_DIR).toBe(path.join(process.cwd(), "data"));
  });

  it("is called by the postinstall with INIT_CWD, where npm was run", () => {
    const seen = [];
    const stub = (file, exports) => {
      const key = require.resolve(file);
      const mod = new Module(key);
      mod.filename = key;
      mod.loaded = true;
      mod.exports = exports;
      require.cache[key] = mod;
      return key;
    };
    const stubbed = [
      stub("../../cli/hooks/sqliteRuntime.js", { ensureSqliteRuntime: () => seen.push(process.env.DATA_DIR) }),
      stub("../../cli/hooks/trayRuntime.js", { ensureTrayRuntime: () => {} }),
    ];
    const postinstall = require.resolve("../../cli/hooks/postinstall.js");
    vi.spyOn(process, "exit").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("DATA_DIR", "data");
    vi.stubEnv("INIT_CWD", tmp);
    try {
      delete require.cache[postinstall];
      require(postinstall);
    } finally {
      delete require.cache[postinstall];
      for (const key of stubbed) delete require.cache[key];
    }
    expect(seen).toEqual([path.join(tmp, "data")]);
    expect(process.exit).toHaveBeenCalledWith(0);
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
