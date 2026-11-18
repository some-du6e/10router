import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { killByPidFile } = require("../../cli/src/cli/utils/pidFile.js");

let tmp;
let pidFile;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-pid-file-"));
  pidFile = path.join(tmp, "cloudflared.pid");
  fs.writeFileSync(pidFile, "4242");
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("CLI tunnel PID file", () => {
  it("kills the PID when it is the expected program", () => {
    const run = vi.fn(() => "/usr/local/bin/cloudflared\n");
    const kill = vi.fn();
    expect(killByPidFile(pidFile, ["cloudflared"], { platform: "linux", run, kill })).toBe(true);
    expect(run).toHaveBeenCalledWith("ps", ["-p", "4242", "-o", "comm="], expect.any(Object));
    expect(kill).toHaveBeenCalledWith(4242, "SIGKILL");
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it("leaves another program alone and removes the stale file", () => {
    const run = vi.fn(() => "postgres\n");
    const kill = vi.fn();
    expect(killByPidFile(pidFile, ["cloudflared"], { platform: "linux", run, kill })).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it("kills nothing when ps fails (no such process, or ps missing)", () => {
    const run = vi.fn(() => { throw new Error("ps exited 1"); });
    const kill = vi.fn();
    expect(killByPidFile(pidFile, ["cloudflared"], { platform: "linux", run, kill })).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it("checks the image name with tasklist on Windows before taskkill", () => {
    const run = vi.fn((cmd) => (cmd === "tasklist" ? '"cloudflared.exe","4242","Console","1","12,345 K"\r\n' : ""));
    const kill = vi.fn();
    expect(killByPidFile(pidFile, ["cloudflared"], { platform: "win32", run, kill })).toBe(true);
    expect(run).toHaveBeenCalledWith("tasklist", ["/FI", "PID eq 4242", "/FO", "CSV", "/NH"], expect.any(Object));
    expect(run).toHaveBeenCalledWith("taskkill", ["/F", "/T", "/PID", "4242"], expect.any(Object));
    expect(kill).not.toHaveBeenCalled();
  });

  it("doesn't taskkill on Windows when the PID runs something else", () => {
    const run = vi.fn((cmd) => (cmd === "tasklist" ? '"explorer.exe","4242","Console","1","99,000 K"\r\n' : ""));
    expect(killByPidFile(pidFile, ["cloudflared"], { platform: "win32", run, kill: vi.fn() })).toBe(false);
    expect(run).not.toHaveBeenCalledWith("taskkill", expect.anything(), expect.anything());
  });

  it("doesn't taskkill on Windows when tasklist finds no such PID", () => {
    const run = vi.fn((cmd) => (cmd === "tasklist" ? "INFO: No tasks are running which match the specified criteria.\r\n" : ""));
    expect(killByPidFile(pidFile, ["cloudflared"], { platform: "win32", run, kill: vi.fn() })).toBe(false);
    expect(run).not.toHaveBeenCalledWith("taskkill", expect.anything(), expect.anything());
  });
});
