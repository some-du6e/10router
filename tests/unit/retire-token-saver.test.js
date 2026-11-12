import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isHeadroomProxy, retireTokenSaver } from "../../src/lib/upgrades/retireTokenSaver.js";

let dir;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

function setup(pid) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "retire-ts-"));
  fs.mkdirSync(path.join(dir, "headroom"));
  fs.writeFileSync(path.join(dir, "headroom", "proxy.pid"), String(pid));
  fs.mkdirSync(path.join(dir, "pxpipe", "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(dir, "db"));
  return dir;
}

describe("Retired Token Saver cleanup", () => {
  it("recognizes only the Headroom proxy command", () => {
    expect(isHeadroomProxy("/home/u/.local/bin/headroom proxy --port 8787 --code-aware")).toBe(true);
    expect(isHeadroomProxy('"C:\\Python\\Scripts\\headroom.exe" proxy --port 8787')).toBe(true);
    expect(isHeadroomProxy("/usr/bin/node server.js")).toBe(false);
    expect(isHeadroomProxy("vim headroom-proxy-notes.txt")).toBe(false);
    expect(isHeadroomProxy("")).toBe(false);
  });

  it("stops the recorded Headroom proxy and removes the old data dirs", () => {
    const dataDir = setup(4242);
    const kill = vi.fn();
    retireTokenSaver({ dataDir, getCommandLine: () => "/usr/local/bin/headroom proxy --port 8787", kill });
    expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(fs.existsSync(path.join(dataDir, "headroom"))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, "pxpipe"))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, "db"))).toBe(true);
  });

  it("leaves a reused PID alone", () => {
    const dataDir = setup(4242);
    const kill = vi.fn();
    retireTokenSaver({ dataDir, getCommandLine: () => "/usr/bin/postgres -D /var/lib/pg", kill });
    expect(kill).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dataDir, "headroom"))).toBe(false);
  });

  it("does nothing on installs that never used it", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "retire-ts-"));
    const kill = vi.fn();
    expect(() => retireTokenSaver({ dataDir: dir, getCommandLine: () => "", kill })).not.toThrow();
    expect(kill).not.toHaveBeenCalled();
  });
});
