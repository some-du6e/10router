import { afterAll, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The tunnel module spawns cloudflared and registers the child so shutdown can
// stop it by its handle. Only spawn and execFileSync are replaced.
const spawned = vi.hoisted(() => []);
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const child = Object.assign(new EventEmitter(), {
        pid: 424242, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(() => true),
      });
      spawned.push(child);
      return child;
    }),
    // The process table is unreadable here; the handle must still work.
    execFileSync: vi.fn(() => ""),
  };
});

// dataDir.js reads DATA_DIR at import; give the tunnel a binary that passes its ELF check.
const previousDataDir = process.env.DATA_DIR;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-cloudflared-"));
process.env.DATA_DIR = dataDir;
fs.mkdirSync(path.join(dataDir, "bin"), { recursive: true });
const fakeBinary = Buffer.alloc(1024 * 1024 + 16);
fakeBinary.write("7f454c46", "hex");
fs.writeFileSync(path.join(dataDir, "bin", "cloudflared"), fakeBinary);

const { spawn } = await import("child_process");
const { spawnQuickTunnel, setUnexpectedExitHandler } = await import("../../src/lib/tunnel/cloudflare/cloudflared.js");
const { killAppProcesses } = await import("../../src/lib/appProcesses.js");

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "linux")("shutdown and the tunnel this server started", () => {
  it("kills its own cloudflared by handle, and the exit neither respawns nor reports a crash", async () => {
    const unexpectedExit = vi.fn();
    setUnexpectedExitHandler(unexpectedExit);

    const tunnel = spawnQuickTunnel(20128, () => {});
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    const child = spawned[0];
    child.stdout.emit("data", Buffer.from("INF |  https://quiet-river-1234.trycloudflare.com  |\n"));
    await expect(tunnel).resolves.toMatchObject({ tunnelUrl: "https://quiet-river-1234.trycloudflare.com" });

    // A killed child exits right after.
    child.kill.mockImplementation((signal) => {
      queueMicrotask(() => child.emit("exit", null, signal));
      return true;
    });

    await killAppProcesses();

    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(unexpectedExit).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
