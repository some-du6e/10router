import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "../..");
const tempDirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-cli-host-"));
  tempDirs.push(dir);
  return dir;
}

// The API client reads and writes its CLI secret under DATA_DIR at require time.
const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = tempDir();
const api = require("../../cli/src/cli/api/client.js");
const { shouldExclude, copyStandaloneBuild } = require("../../cli/scripts/build-cli.js");

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("CLI API client host", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    [undefined, "127.0.0.1"],
    ["0.0.0.0", "127.0.0.1"],
    ["localhost", "127.0.0.1"],
    ["::", "::1"],
    ["[::]", "::1"],
    ["[::1]", "::1"],
    ["192.168.1.5", "192.168.1.5"],
  ])("a server bound to %s is dialed on %s", async (bindHost, expected) => {
    const request = vi.spyOn(http, "request").mockImplementation(() => {
      const req = Object.assign(new EventEmitter(), { write() {}, end() { queueMicrotask(() => req.emit("error", new Error("stub"))); }, setTimeout() {}, destroy() {} });
      return req;
    });
    api.configure({ port: 20200, host: api.hostForBind(bindHost) });

    await api.getTunnelStatus();

    expect(request).toHaveBeenCalled();
    expect(request.mock.calls[0][0]).toMatchObject({ hostname: expected, port: 20200 });
  });

  it("is configured once by the launcher, not per Terminal UI session", () => {
    const cli = fs.readFileSync(path.join(repoRoot, "cli/cli.js"), "utf8");
    const terminalUI = fs.readFileSync(path.join(repoRoot, "cli/src/cli/terminalUI.js"), "utf8");
    expect(cli).toMatch(/api\.configure\(\s*\{\s*port\s*,\s*host\s*:\s*dialHost\s*\}\s*\)/);
    expect(cli).not.toMatch(/host\s*:\s*["']127\.0\.0\.1["']\s*,\s*port/);
    expect(terminalUI).not.toMatch(/api\.configure\s*\(/);
  });
});

describe("env files stay out of packages", () => {
  it("the CLI build never copies env files from the build machine", () => {
    for (const name of [".env", ".env.local", ".env.production", ".env.production.local", ".env.development"]) {
      expect(shouldExclude(name), name).toBe(true);
    }
    expect(shouldExclude("server.js")).toBe(false);

    const root = tempDir();
    const appDir = path.join(root, "10router");
    const buildDistDir = path.join(root, ".next-cli-build");
    const cliAppDir = path.join(root, "cli-app");
    const standalone = path.join(buildDistDir, "standalone");
    fs.mkdirSync(path.join(standalone, "node_modules", "next"), { recursive: true });
    fs.writeFileSync(path.join(standalone, "server.js"), "server");
    fs.writeFileSync(path.join(standalone, ".env.production"), "JWT_SECRET=from-the-build-machine");
    fs.writeFileSync(path.join(standalone, ".env"), "API_KEY_SECRET=x");
    fs.writeFileSync(path.join(standalone, "node_modules", "next", "index.js"), "next");

    copyStandaloneBuild(appDir, buildDistDir, cliAppDir);

    expect(fs.existsSync(path.join(cliAppDir, "server.js"))).toBe(true);
    expect(fs.existsSync(path.join(cliAppDir, "node_modules", "next", "index.js"))).toBe(true);
    expect(fs.existsSync(path.join(cliAppDir, ".env.production"))).toBe(false);
    expect(fs.existsSync(path.join(cliAppDir, ".env"))).toBe(false);
  });

  it(".dockerignore keeps every .env file but .env.example out of the build context", () => {
    // Docker's rules for a file path: each line is a glob (`**/` = any depth),
    // `!` re-includes, last match wins.
    const rules = fs.readFileSync(path.join(repoRoot, ".dockerignore"), "utf8").split(/\r?\n/)
      .map((line) => line.trim()).filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const negate = line.startsWith("!");
        const glob = negate ? line.slice(1) : line;
        const source = glob.split("**/").map((part) => part
          .replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")).join("(?:.*/)?");
        return { negate, regex: new RegExp(`^${source}$`) };
      });
    const ignored = (name) => rules.reduce((state, rule) => (rule.regex.test(name) ? !rule.negate : state), false);

    for (const name of [".env", ".env.local", ".env.production", ".env.production.local", ".env.development"]) {
      expect(ignored(name), name).toBe(true);
      expect(ignored(`open-sse/${name}`), `open-sse/${name}`).toBe(true);
      expect(ignored(`src/lib/${name}`), `src/lib/${name}`).toBe(true);
    }
    expect(ignored(".env.example")).toBe(false);
    expect(ignored("open-sse/.env.example")).toBe(false);
    expect(ignored("package.json")).toBe(false);
    expect(ignored("src/lib/env.js")).toBe(false);
  });
});
