import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { acquireDataDirLock, tryLock, lockPath, processStartTime, unsafeDataDirReason, LOCK_FILE } = require("../../cli/src/cli/utils/dataDirLock.js");

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-lock-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const running = (...live) => (holder) => live.some(([pid, startTime]) => holder.pid === pid && holder.startTime === startTime);
const writeLock = (holder) => fs.writeFileSync(lockPath(dir), JSON.stringify(holder));
const readLock = () => JSON.parse(fs.readFileSync(lockPath(dir), "utf8"));
const leftovers = () => fs.readdirSync(dir).filter((name) => name !== LOCK_FILE);

describe("one launcher per DATA_DIR", () => {
  it("refuses a second launcher while the first runs, and lets it in after release", () => {
    const first = tryLock(dir, { pid: 111, startTime: "t1", isRunning: running([111, "t1"]) });
    expect(first.ok).toBe(true);
    expect(readLock()).toEqual({ pid: 111, startTime: "t1" });
    if (process.platform !== "win32") expect(fs.statSync(lockPath(dir)).mode & 0o777).toBe(0o600);
    expect(leftovers()).toEqual([]);

    expect(tryLock(dir, { pid: 222, startTime: "t2", isRunning: running([111, "t1"]) })).toMatchObject({ ok: false, holder: { pid: 111 } });
    first.release();
    expect(tryLock(dir, { pid: 222, startTime: "t2", isRunning: running([111, "t1"]) }).ok).toBe(true);
  });

  // A launcher SIGKILLed by an update or by a Windows logoff never runs its
  // exit handlers; after a reboot its PID can belong to another program.
  it("takes over a lock whose PID now runs with a different start time", () => {
    writeLock({ pid: 111, startTime: "before-reboot" });
    const isRunning = vi.fn(running([111, "after-reboot"]));
    expect(tryLock(dir, { pid: 222, startTime: "t2", isRunning }).ok).toBe(true);
    expect(isRunning).toHaveBeenCalledWith({ pid: 111, startTime: "before-reboot" });
    expect(readLock().pid).toBe(222);
    expect(leftovers()).toEqual([]);
  });

  it("takes over an unreadable lock", () => {
    fs.writeFileSync(lockPath(dir), "garbage");
    expect(tryLock(dir, { pid: 222, startTime: "t2", isRunning: () => true }).ok).toBe(true);
  });

  // Both launchers judge the same lock stale. B takes it over first; A's
  // takeover must then find B's fresh lock, put it back and give way.
  it("never deletes a fresh lock when two takeovers interleave", () => {
    writeLock({ pid: 111, startTime: "dead" });
    let b;
    const aIsRunning = (holder) => {
      if (holder.pid === 111 && !b) {
        b = tryLock(dir, { pid: 222, startTime: "tb", isRunning: (h) => h.pid === 222 });
      }
      return holder.pid === 222;
    };
    const a = tryLock(dir, { pid: 333, startTime: "ta", isRunning: aIsRunning });
    expect(b.ok).toBe(true);
    expect(a).toMatchObject({ ok: false, holder: { pid: 222 } });
    expect(readLock()).toEqual({ pid: 222, startTime: "tb" });
    expect(leftovers()).toEqual([]);
  });

  it("doesn't remove another launcher's lock on release", () => {
    const first = tryLock(dir, { pid: 111, startTime: "t1", isRunning: () => false });
    tryLock(dir, { pid: 222, startTime: "t2", isRunning: () => false });
    first.release();
    expect(readLock().pid).toBe(222);
  });

  it("never shows a reader an empty lock while it is being created", () => {
    const seen = [];
    const link = fs.linkSync;
    const spy = vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
      seen.push(fs.readFileSync(from, "utf8"));
      return link(from, to);
    });
    try {
      tryLock(dir, { pid: 111, startTime: "t1" });
    } finally {
      spy.mockRestore();
    }
    expect(seen).toEqual([JSON.stringify({ pid: 111, startTime: "t1" })]);
  });

  it("waits for a tray handoff to release the lock", async () => {
    const old = tryLock(dir, { pid: 111, startTime: "t1", isRunning: () => true });
    setTimeout(old.release, 50);
    const next = await acquireDataDirLock(dir, { pid: 222, startTime: "t2", isRunning: running([111, "t1"]), waitMs: 2000, intervalMs: 10 });
    expect(next.ok).toBe(true);
  });

  it("locks against this process for real", () => {
    const mine = tryLock(dir);
    expect(mine.ok).toBe(true);
    expect(tryLock(dir, { pid: process.pid + 1, startTime: "other" })).toMatchObject({ ok: false, holder: { pid: process.pid } });
    mine.release();
  });
});

describe("process start time", () => {
  const enoent = () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };

  it("reads field 22 of /proc/<pid>/stat, even when the command name has spaces and parentheses", () => {
    const stat = "4242 (node (my) app) S 1 4242 4242 0 -1 4194560 100 0 0 0 5 1 0 0 20 0 11 0 987654 1000 200 18446744073709551615";
    const readFile = vi.fn(() => stat);
    expect(processStartTime(4242, { platform: "linux", readFile, run: vi.fn() })).toBe("ticks:987654");
    expect(readFile).toHaveBeenCalledWith("/proc/4242/stat", "utf8");
  });

  it("asks ps for lstart where there is no /proc", () => {
    const run = vi.fn(() => "Wed Nov 18 15:25:02 2026\n");
    expect(processStartTime(4242, { platform: "darwin", readFile: enoent, run })).toBe("lstart:Wed Nov 18 15:25:02 2026");
    expect(run).toHaveBeenCalledWith("ps", ["-p", "4242", "-o", "lstart="], expect.any(Object));
  });

  it("is null when the process is gone", () => {
    const run = vi.fn(() => { throw new Error("exit 1"); });
    expect(processStartTime(4242, { platform: "darwin", readFile: enoent, run })).toBeNull();
  });

  it("is null for another user's process that /proc won't show", () => {
    const readFile = () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); };
    expect(processStartTime(4242, { platform: "linux", readFile, run: vi.fn() })).toBeNull();
  });

  it("uses the Win32 CreationDate on Windows, not just the image name", () => {
    const run = vi.fn(() => "2026-11-18T15:25:02.1234560Z\r\n");
    expect(processStartTime(4242, { platform: "win32", run })).toBe("2026-11-18T15:25:02.1234560Z");
    const [cmd, args] = run.mock.calls[0];
    expect(cmd).toBe("powershell.exe");
    expect(args.at(-1)).toContain("ProcessId=4242");
    expect(args.at(-1)).toContain("CreationDate");
    expect(processStartTime(4242, { platform: "win32", run: () => "" })).toBeNull();
  });

  it.skipIf(process.platform !== "linux")("is stable for this process", () => {
    expect(processStartTime(process.pid)).toBe(processStartTime(process.pid));
    expect(processStartTime(process.pid)).toMatch(/^ticks:\d+$/);
  });
});

describe("DATA_DIR from an autostart entry", () => {
  const stat = (st) => () => st;

  it("accepts a directory this user owns that nobody else can write", () => {
    expect(unsafeDataDirReason("/d", { uid: 501, stat: stat({ uid: 501, mode: 0o40700 }) })).toBeNull();
    expect(unsafeDataDirReason("/d", { uid: 501, stat: stat({ uid: 501, mode: 0o40755 }) })).toBeNull();
  });

  it("refuses one owned by another user", () => {
    expect(unsafeDataDirReason("/d", { uid: 501, stat: stat({ uid: 0, mode: 0o40700 }) })).toMatch(/owned by user 0/);
  });

  it("refuses one that group or others can write", () => {
    expect(unsafeDataDirReason("/d", { uid: 501, stat: stat({ uid: 501, mode: 0o40775 }) })).toMatch(/mode 775/);
    expect(unsafeDataDirReason("/d", { uid: 501, stat: stat({ uid: 501, mode: 0o40757 }) })).toMatch(/mode 757/);
  });

  it("is fine with a directory that doesn't exist yet, and on Windows", () => {
    expect(unsafeDataDirReason("/nope", { uid: 501, stat: () => { throw new Error("ENOENT"); } })).toBeNull();
    expect(unsafeDataDirReason("C:\\d", { uid: undefined })).toBeNull();
  });

  it("is checked by cli.js only when the entry set TENROUTER_AUTOSTART", () => {
    const cli = fs.readFileSync(path.resolve(import.meta.dirname, "../../cli/cli.js"), "utf8");
    expect(cli).toMatch(/^if \(process\.env\[AUTOSTART_ENV\] === "1" && process\.env\.DATA_DIR\) \{$/m);
    expect(cli).toMatch(/^ {2}const unsafe = unsafeDataDirReason\(process\.env\.DATA_DIR\);$/m);
  });
});
