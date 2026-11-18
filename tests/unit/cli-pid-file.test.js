import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { killByPidFile } = require("../../cli/src/cli/utils/pidFile.js");

let tmp;
let pidFile;
let ownBinary;

const enoent = () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };
const eacces = () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); };
const realpath = (p) => p;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-pid-file-"));
  pidFile = path.join(tmp, "tunnel", "cloudflared.pid");
  fs.mkdirSync(path.dirname(pidFile));
  fs.writeFileSync(pidFile, "4242");
  ownBinary = path.join(tmp, "bin", "cloudflared");
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("CLI cloudflared PID file", () => {
  it("kills the PID when /proc shows it runs the server's own binary", () => {
    const readlink = vi.fn(() => ownBinary);
    const run = vi.fn();
    const kill = vi.fn();
    expect(killByPidFile(pidFile, ownBinary, { platform: "linux", readlink, realpath, run, kill })).toBe(true);
    expect(readlink).toHaveBeenCalledWith("/proc/4242/exe");
    expect(run).not.toHaveBeenCalled();
    expect(kill).toHaveBeenCalledWith(4242, "SIGKILL");
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it("compares the paths after resolving symlinks", () => {
    const linked = path.join(tmp, "link", "cloudflared");
    const resolve = (p) => (p === linked ? ownBinary : p);
    const kill = vi.fn();
    expect(killByPidFile(pidFile, ownBinary, { platform: "linux", readlink: () => linked, realpath: resolve, run: vi.fn(), kill })).toBe(true);
    expect(kill).toHaveBeenCalled();
  });

  it("leaves a system cloudflared alone and removes the stale file", () => {
    const kill = vi.fn();
    const readlink = () => "/usr/local/bin/cloudflared";
    expect(killByPidFile(pidFile, ownBinary, { platform: "linux", readlink, realpath, run: vi.fn(), kill })).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it("leaves another user's process alone when /proc refuses", () => {
    const run = vi.fn(() => `${ownBinary}\n`);
    const kill = vi.fn();
    expect(killByPidFile(pidFile, ownBinary, { platform: "linux", readlink: eacces, realpath, run, kill })).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it("falls back to ps without /proc and matches its full path", () => {
    const run = vi.fn(() => `${ownBinary}\n`);
    const kill = vi.fn();
    expect(killByPidFile(pidFile, ownBinary, { platform: "darwin", readlink: enoent, realpath, run, kill })).toBe(true);
    expect(run).toHaveBeenCalledWith("ps", ["-p", "4242", "-o", "comm="], expect.any(Object));
    expect(kill).toHaveBeenCalledWith(4242, "SIGKILL");
  });

  it("doesn't kill another cloudflared that ps names by full path", () => {
    const run = vi.fn(() => "/opt/homebrew/bin/cloudflared\n");
    const kill = vi.fn();
    expect(killByPidFile(pidFile, ownBinary, { platform: "darwin", readlink: enoent, realpath, run, kill })).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it("matches the basename when ps prints only a name", () => {
    const kill = vi.fn();
    expect(killByPidFile(pidFile, ownBinary, { platform: "darwin", readlink: enoent, realpath, run: () => "cloudflared\n", kill })).toBe(true);
    expect(kill).toHaveBeenCalledTimes(1);
    fs.writeFileSync(pidFile, "4242");
    expect(killByPidFile(pidFile, ownBinary, { platform: "darwin", readlink: enoent, realpath, run: () => "postgres\n", kill })).toBe(false);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("kills nothing when ps fails too", () => {
    const run = vi.fn(() => { throw new Error("ps exited 1"); });
    const kill = vi.fn();
    expect(killByPidFile(pidFile, ownBinary, { platform: "darwin", readlink: enoent, realpath, run, kill })).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it("checks the image name with tasklist on Windows before taskkill", () => {
    const exe = path.join(tmp, "bin", "cloudflared.exe");
    const run = vi.fn((cmd) => (cmd === "tasklist" ? '"cloudflared.exe","4242","Console","1","12,345 K"\r\n' : ""));
    const kill = vi.fn();
    expect(killByPidFile(pidFile, exe, { platform: "win32", run, kill })).toBe(true);
    expect(run).toHaveBeenCalledWith("tasklist", ["/FI", "PID eq 4242", "/FO", "CSV", "/NH"], expect.any(Object));
    expect(run).toHaveBeenCalledWith("taskkill", ["/F", "/T", "/PID", "4242"], expect.any(Object));
    expect(kill).not.toHaveBeenCalled();
  });

  it("doesn't taskkill on Windows when the PID runs something else", () => {
    const exe = path.join(tmp, "bin", "cloudflared.exe");
    const run = vi.fn((cmd) => (cmd === "tasklist" ? '"explorer.exe","4242","Console","1","99,000 K"\r\n' : ""));
    expect(killByPidFile(pidFile, exe, { platform: "win32", run, kill: vi.fn() })).toBe(false);
    expect(run).not.toHaveBeenCalledWith("taskkill", expect.anything(), expect.anything());
  });

  // The server reads this file without checking the PID, so an unverifiable
  // one must not be left behind for it.
  it("removes the PID file on Windows when tasklist can't run, without taskkill", () => {
    const exe = path.join(tmp, "bin", "cloudflared.exe");
    const run = vi.fn((cmd) => { if (cmd === "tasklist") throw Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }); return ""; });
    expect(killByPidFile(pidFile, exe, { platform: "win32", run, kill: vi.fn() })).toBe(false);
    expect(run).not.toHaveBeenCalledWith("taskkill", expect.anything(), expect.anything());
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it("doesn't taskkill on Windows when tasklist finds no such PID", () => {
    const exe = path.join(tmp, "bin", "cloudflared.exe");
    const run = vi.fn((cmd) => (cmd === "tasklist" ? "INFO: No tasks are running which match the specified criteria.\r\n" : ""));
    expect(killByPidFile(pidFile, exe, { platform: "win32", run, kill: vi.fn() })).toBe(false);
    expect(run).not.toHaveBeenCalledWith("taskkill", expect.anything(), expect.anything());
  });
});
