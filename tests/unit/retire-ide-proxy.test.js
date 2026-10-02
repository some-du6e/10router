import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const { removeRedirects, isHistoricalProxy, retire } = createRequire(import.meta.url)("../../src/lib/upgrades/retireIdeProxy.cjs");
let dir;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

describe("Retired IDE proxy cleanup", () => {
  it("preserves unrelated aliases, remote mappings, comments, and line endings", () => {
    const content = "# api2.cursor.sh\r\n127.0.0.1 localhost api2.cursor.sh # keep me\r\n10.1.2.3 api2.cursor.sh\r\n127.0.0.1 api2.cursor.sh.evil\r\n127.0.0.1 daily-cloudcode-pa.googleapis.com\r\n";
    expect(removeRedirects(content)).toBe("# api2.cursor.sh\r\n127.0.0.1 localhost # keep me\r\n10.1.2.3 api2.cursor.sh\r\n127.0.0.1 api2.cursor.sh.evil\r\n");
    expect(removeRedirects(removeRedirects(content))).toBe(removeRedirects(content));
  });

  it("validates exact historical entrypoints instead of arbitrary PID-file contents", () => {
    expect(isHistoricalProxy("sudo -S -E sh -c HOME='\"/home/user\"' NODE_ENV=production '/usr/bin/node' '/data/runtime/mitm/server.js'", "/data", "/app")).toBe(true);
    expect(isHistoricalProxy("/usr/bin/node /data/runtime/mitm/server.js", "/data", "/app")).toBe(true);
    expect(isHistoricalProxy("/usr/bin/node /app/src/mitm/server.js", "/data", "/app")).toBe(true);
    expect(isHistoricalProxy("/usr/bin/node /data/runtime/mitm/server.js.evil", "/data", "/app")).toBe(false);
    expect(isHistoricalProxy("/usr/bin/node /unrelated/server.js", "/data", "/app")).toBe(false);
    expect(isHistoricalProxy("/usr/bin/node /unrelated/server.js /data/runtime/mitm/server.js", "/data", "/app")).toBe(false);
    expect(isHistoricalProxy("sh -c echo /data/runtime/mitm/server.js", "/data", "/app")).toBe(false);
  });

  it("cleans fixture redirects and gracefully stops only a verified old proxy", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-retire-"));
    fs.mkdirSync(path.join(dir, "mitm"));
    fs.writeFileSync(path.join(dir, "mitm", ".mitm.pid"), "12345");
    const hostsPath = path.join(dir, "hosts");
    fs.writeFileSync(hostsPath, "127.0.0.1 localhost\n127.0.0.1 api.individual.githubcopilot.com\n");
    let running = true;
    const kill = vi.fn(() => { running = false; });
    const options = { processes: () => [], dataDir: dir, appRoot: "/app", hostsPath, commandLine: () => running ? `/usr/bin/node ${dir}/runtime/mitm/server.js` : "", kill, wait: async () => {} };
    expect(await retire(options)).toMatchObject({ needed: true, proxyRunning: true });
    expect(kill).not.toHaveBeenCalled();
    await retire({ ...options, apply: true });
    expect(kill).toHaveBeenCalledExactlyOnceWith(12345, "SIGTERM");
    expect(fs.readFileSync(hostsPath, "utf8")).toBe("127.0.0.1 localhost\n");
    expect(await retire(options)).toMatchObject({ needed: false });
  });

  it("does not signal an unrelated process referenced by a stale PID file", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-retire-"));
    fs.mkdirSync(path.join(dir, "mitm"));
    fs.writeFileSync(path.join(dir, "mitm", ".mitm.pid"), "12345");
    const hostsPath = path.join(dir, "hosts");
    fs.writeFileSync(hostsPath, "127.0.0.1 localhost\n");
    const kill = vi.fn();
    await retire({ processes: () => [], dataDir: dir, appRoot: "/app", hostsPath, commandLine: () => "/usr/bin/node /unrelated/server.js", kill, apply: true });
    expect(kill).not.toHaveBeenCalled();
  });
});
