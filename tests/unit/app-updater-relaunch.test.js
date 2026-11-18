import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const spawn = vi.fn(() => ({ unref() {} }));
vi.mock("child_process", () => ({ spawn, execFileSync: vi.fn(() => "") }));

const { buildRelaunchArgs, dialHostForBind, serverBind, isValidHost, spawnUpdaterAndExit } = await import("../../src/lib/appUpdater.js");

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "../..");
const cliArgs = require("../../cli/src/cli/utils/launchArgs.js");
const cliClient = require("../../cli/src/cli/api/client.js");

const PARENT = 4321;
const launched = { TENROUTER_LAUNCHER_PID: String(PARENT), PORT: "20200", HOSTNAME: "127.0.0.1" };

describe("dashboard update relaunch", () => {
  it("brings a --host/--port launch back on the same address", () => {
    expect(buildRelaunchArgs(launched, PARENT)).toEqual(["10router", "--skip-update", "--port", "20200", "--host", "127.0.0.1"]);
    expect(buildRelaunchArgs({ ...launched, TRAY_MODE: "1" }, PARENT)).toEqual(["10router", "--tray", "--skip-update", "--port", "20200", "--host", "127.0.0.1"]);
  });

  // Without the launcher as our parent, HOSTNAME is usually the machine's
  // name, and TENROUTER_LAUNCHER_PID may be a stale inherited value.
  it("ignores HOSTNAME unless the launcher named in the env is our parent", () => {
    expect(serverBind({ PORT: "20200", HOSTNAME: "build-box" }, PARENT)).toEqual({ port: 20200, host: "" });
    expect(serverBind(launched, PARENT + 1)).toEqual({ port: 20200, host: "" });
    expect(buildRelaunchArgs({ PORT: "20200", HOSTNAME: "build-box" }, PARENT)).not.toContain("--host");
  });

  // On Windows the relaunch runs npx.cmd through a shell.
  it.each(["a&calc", "x y", 'x"y', "x\ny", "%PATH%", "$(id)"])("never passes HOSTNAME %j on", (hostname) => {
    expect(serverBind({ ...launched, HOSTNAME: hostname }, PARENT).host).toBe("");
  });

  it.each(["", "abc", "0", "70000", "20200abc"])("falls back to the default port for PORT %j", (port) => {
    expect(serverBind({ PORT: port }, PARENT).port).toBe(20128);
  });

  it("waits on the address the server is reachable at", () => {
    expect(dialHostForBind("")).toBe("127.0.0.1");
    expect(dialHostForBind("0.0.0.0")).toBe("127.0.0.1");
    expect(dialHostForBind("::")).toBe("::1");
    expect(dialHostForBind("192.168.1.5")).toBe("192.168.1.5");
  });

  it.each(["", "0.0.0.0", "localhost", "::", "[::1]", "::1", "127.0.0.1", "192.168.1.5", " 10.0.0.2 ", "my-host.lan"])("dials %j the same way as the CLI", (bind) => {
    expect(dialHostForBind(bind)).toBe(cliClient.hostForBind(bind));
  });

  it.each(["127.0.0.1", "::1", "localhost", "my-host.lan", "", "a b", 'x"y', "x\ny", "-x", "[::1]", "a&b", "x".repeat(254)])("validates host %j the same way as the CLI", (host) => {
    expect(isValidHost(host)).toBe(cliArgs.isValidHost(host));
  });

  it("the updater waits on and opens the address it was given", () => {
    const updater = fs.readFileSync(path.join(repoRoot, "src/lib/updater/updater.js"), "utf8");
    expect(updater).toContain("socket.connect(appPort, appHost);");
    expect(updater).toContain('const appHost = process.env.UPDATER_APP_HOST || "127.0.0.1";');
  });
});

describe("spawnUpdaterAndExit", () => {
  let dataDir;
  beforeEach(() => {
    vi.useFakeTimers();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "updater-env-"));
    vi.stubEnv("DATA_DIR", dataDir);
    vi.stubEnv("TENROUTER_LAUNCHER_PID", String(process.ppid));
    vi.stubEnv("PORT", "20200");
    vi.stubEnv("HOSTNAME", "192.168.1.5");
    vi.stubEnv("TRAY_MODE", "1");
    spawn.mockClear();
  });
  afterEach(() => {
    // Drops the pending process.exit timer without running it.
    vi.useRealTimers();
    vi.unstubAllEnvs();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("hands the updater this server's address and a relaunch that keeps the bind", () => {
    spawnUpdaterAndExit();
    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, , options] = spawn.mock.calls[0];
    expect(cmd).toBe(process.execPath);
    expect(options.env.UPDATER_APP_PORT).toBe("20200");
    expect(options.env.UPDATER_APP_HOST).toBe("192.168.1.5");
    expect(JSON.parse(options.env.UPDATER_RELAUNCH_ARGS)).toEqual(["10router", "--tray", "--skip-update", "--port", "20200", "--host", "192.168.1.5"]);
  });

  it("dials loopback for a wildcard bind", () => {
    vi.stubEnv("HOSTNAME", "0.0.0.0");
    spawnUpdaterAndExit();
    expect(spawn.mock.calls[0][2].env.UPDATER_APP_HOST).toBe("127.0.0.1");
  });
});
