import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// cloudflared's PID file lives in DATA_DIR, which a Docker volume keeps across
// restarts. Its number can belong to this server in the next container (PID 1),
// to any other process, or name a process group, and killCloudflared signals
// whatever it trusts. So the PID counts only while it runs our own binary.
describe("cloudflared PID ownership", () => {
  let dataDir;
  const children = [];

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-tunnel-pid-"));
    process.env.DATA_DIR = dataDir;
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const child of children.splice(0)) child.kill("SIGKILL");
    delete process.env.DATA_DIR;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const pidFile = () => path.join(dataDir, "tunnel", "cloudflared.pid");
  function writePidFile(contents) {
    fs.mkdirSync(path.join(dataDir, "tunnel"), { recursive: true });
    fs.writeFileSync(pidFile(), contents);
  }

  // A live process that is not cloudflared.
  function otherProcess() {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    children.push(child);
    return child;
  }

  it("does not let an old child clear its successor PID", async () => {
    const { clearPid, loadPid, savePid } = await import("../../src/lib/tunnel/cloudflare/pid.js");

    savePid(100);
    savePid(200);
    clearPid(100);

    expect(loadPid()).toBe(200);

    clearPid(200);
    expect(loadPid()).toBeNull();
  });

  it("releases PID and process ownership for the exiting child only", () => {
    const source = fs.readFileSync(new URL("../../src/lib/tunnel/cloudflare/cloudflared.js", import.meta.url), "utf8");

    expect(source.match(/clearPid\(child\.pid\)/g)).toHaveLength(2);
    expect(source.match(/cloudflaredProcess === child/g)).toHaveLength(2);
  });

  it.each([
    ["PID 1, this server in a fresh container", "1"],
    ["0, this process group", "0"],
    ["a negative PID, a process group", "-37"],
    ["garbage", "abc"],
    ["an empty file", ""],
  ])("loadPid never hands out %s", async (_label, contents) => {
    const { loadPid } = await import("../../src/lib/tunnel/cloudflare/pid.js");
    writePidFile(contents);
    expect(loadPid()).toBeNull();
  });

  it("never hands out this server's own PID or its parent's", async () => {
    const { usablePid } = await import("../../src/lib/tunnel/cloudflare/pid.js");
    expect(usablePid(String(process.pid))).toBeNull();
    expect(usablePid(String(process.ppid))).toBeNull();
    expect(usablePid("900", 900, 1)).toBeNull();
    expect(usablePid("900", 2, 900)).toBeNull();
    expect(usablePid(" 900\n", 2, 3)).toBe(900);
  });

  describe("runsBinary", () => {
    it("matches /proc/<pid>/exe against the expected binary", async () => {
      const { runsBinary } = await import("../../src/lib/tunnel/cloudflare/pid.js");
      const probe = { platform: "linux", realpath: (p) => p, run: () => { throw new Error("no ps"); } };
      expect(runsBinary(42, "/data/bin/cloudflared", { ...probe, readlink: () => "/data/bin/cloudflared" })).toBe(true);
      expect(runsBinary(42, "/data/bin/cloudflared", { ...probe, readlink: () => "/usr/local/bin/node" })).toBe(false);
    });

    it("refuses another user's process it may not inspect", async () => {
      const { runsBinary } = await import("../../src/lib/tunnel/cloudflare/pid.js");
      const denied = () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); };
      const run = vi.fn(() => "/data/bin/cloudflared");
      expect(runsBinary(42, "/data/bin/cloudflared", { platform: "linux", readlink: denied, run })).toBe(false);
      expect(run).not.toHaveBeenCalled();
    });

    it("falls back to the path ps prints where there is no /proc", async () => {
      const { runsBinary } = await import("../../src/lib/tunnel/cloudflare/pid.js");
      const missing = () => { throw Object.assign(new Error("no /proc"), { code: "ENOENT" }); };
      const probe = { platform: "darwin", readlink: missing, realpath: (p) => p };
      expect(runsBinary(42, "/data/bin/cloudflared", { ...probe, run: () => "/data/bin/cloudflared\n" })).toBe(true);
      expect(runsBinary(42, "/data/bin/cloudflared", { ...probe, run: () => "/usr/bin/other\n" })).toBe(false);
      expect(runsBinary(42, "/data/bin/cloudflared", { ...probe, run: () => "" })).toBe(false);
    });

    it("compares the image name on Windows", async () => {
      const { runsBinary } = await import("../../src/lib/tunnel/cloudflare/pid.js");
      const run = (_cmd, args) => `"cloudflared.exe","${args[1].split(" ").pop()}","Console","1","20,000 K"\r\n`;
      // Forward slashes, so the host's path module finds the file name here too.
      expect(runsBinary(42, "C:/data/bin/cloudflared.exe", { platform: "win32", run })).toBe(true);
      expect(runsBinary(42, "C:/data/bin/other.exe", { platform: "win32", run })).toBe(false);
    });
  });

  describe("killCloudflared and isCloudflaredRunning", () => {
    it.each([["1"], ["-37"]])("signal nothing and report no tunnel for a PID file holding %s, and remove the file", async (contents) => {
      const { killCloudflared, isCloudflaredRunning } = await import("../../src/lib/tunnel/cloudflare/cloudflared.js");
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

      writePidFile(contents);
      expect(isCloudflaredRunning()).toBe(false);
      expect(fs.existsSync(pidFile())).toBe(false);

      writePidFile(contents);
      killCloudflared();
      expect(kill).not.toHaveBeenCalled();
      expect(fs.existsSync(pidFile())).toBe(false);
    });

    it("signal nothing for a live PID that runs another program, and remove the stale file", async () => {
      const { killCloudflared, isCloudflaredRunning } = await import("../../src/lib/tunnel/cloudflare/cloudflared.js");
      const other = otherProcess();
      const kill = vi.spyOn(process, "kill");

      writePidFile(String(other.pid));
      expect(isCloudflaredRunning()).toBe(false);
      expect(fs.existsSync(pidFile())).toBe(false);

      writePidFile(String(other.pid));
      killCloudflared();
      expect(kill).not.toHaveBeenCalled();
      expect(fs.existsSync(pidFile())).toBe(false);
      expect(other.exitCode).toBeNull();
    });

    it.skipIf(process.platform !== "linux")("still stops a PID that runs our own <DATA_DIR>/bin/cloudflared", async () => {
      // Stand in for the binary with a link to node: /proc/<pid>/exe then
      // resolves to the same file as <DATA_DIR>/bin/cloudflared.
      fs.mkdirSync(path.join(dataDir, "bin"), { recursive: true });
      fs.symlinkSync(process.execPath, path.join(dataDir, "bin", "cloudflared"));
      const { killCloudflared, isCloudflaredRunning } = await import("../../src/lib/tunnel/cloudflare/cloudflared.js");
      const ours = otherProcess();
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

      writePidFile(String(ours.pid));
      expect(isCloudflaredRunning()).toBe(true);
      killCloudflared();
      expect(kill).toHaveBeenCalledWith(ours.pid);
      expect(fs.existsSync(pidFile())).toBe(false);
    });
  });
});
