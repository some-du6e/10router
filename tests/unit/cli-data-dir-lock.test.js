import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { acquireDataDirLock, tryLock, lockPath, processStartTime, holderRuns, unsafeDataDirReason, LOCK_FILE, UNKNOWN } = require("../../cli/src/cli/utils/dataDirLock.js");
const cliSource = () => fs.readFileSync(path.resolve(import.meta.dirname, "../../cli/cli.js"), "utf8").replace(/\r\n/g, "\n");

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

  // A third launcher creates a lock between A moving B's fresh lock aside and
  // putting it back. A must not carry on as if the way were clear.
  it("reports a conflict when a third launcher got in during a takeover", () => {
    writeLock({ pid: 111, startTime: "dead" });
    let b;
    let c;
    const rename = fs.renameSync;
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      rename(from, to);
      if (b?.ok && !c && fs.readFileSync(to, "utf8").includes('"pid":222')) {
        c = tryLock(dir, { pid: 444, startTime: "tc", isRunning: () => false });
      }
    });
    try {
      const aIsRunning = (holder) => {
        if (holder.pid === 111 && !b) b = tryLock(dir, { pid: 222, startTime: "tb", isRunning: () => false });
        return holder.pid !== 111;
      };
      const a = tryLock(dir, { pid: 333, startTime: "ta", isRunning: aIsRunning });
      expect(c.ok).toBe(true);
      expect(a).toMatchObject({ ok: false, conflict: true, holder: { pid: 444 } });
      expect(readLock().pid).toBe(444);
      // B's lock, moved aside by A, is left alone rather than deleted, and B
      // finds out at its next check (before every server start).
      const aside = leftovers();
      expect(aside).toHaveLength(1);
      expect(JSON.parse(fs.readFileSync(path.join(dir, aside[0]), "utf8")).pid).toBe(222);
      expect(b.stillHeld()).toBe(false);
      expect(c.stillHeld()).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it.each(["EPERM", "EROFS"])("still refuses a live holder when it can't create its own lock (%s)", (code) => {
    writeLock({ pid: 111, startTime: "t1" });
    const write = fs.writeFileSync;
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation((file, ...rest) => {
      if (String(file).endsWith(".tmp")) throw Object.assign(new Error(code), { code });
      return write(file, ...rest);
    });
    try {
      expect(tryLock(dir, { pid: 222, startTime: "t2", isRunning: running([111, "t1"]) })).toMatchObject({ ok: false, holder: { pid: 111 } });
      fs.unlinkSync(lockPath(dir));
      // Nobody holds it: run without a lock rather than not at all.
      expect(tryLock(dir, { pid: 222, startTime: "t2", isRunning: running([111, "t1"]) }).ok).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  describe("a holder that can't be checked", () => {
    const unknown = () => UNKNOWN;

    it("is refused, not taken over, while the check fails", () => {
      writeLock({ pid: 111, startTime: "t1" });
      expect(tryLock(dir, { pid: 222, startTime: "t2", isRunning: unknown })).toMatchObject({ ok: false, unknown: true, holder: { pid: 111 } });
    });

    it("is retried until the deadline, and refused if its lock is from this boot", async () => {
      writeLock({ pid: 111, startTime: "t1" });
      const isRunning = vi.fn(unknown);
      const result = await acquireDataDirLock(dir, { pid: 222, startTime: "t2", isRunning, waitMs: 0, unknownWaitMs: 60, intervalMs: 10 });
      expect(result).toMatchObject({ ok: false, unknown: true, file: lockPath(dir) });
      expect(isRunning.mock.calls.length).toBeGreaterThan(2);
      expect(readLock().pid).toBe(111);
    });

    it("is taken over when its lock was written before this boot", async () => {
      writeLock({ pid: 111, startTime: "t1" });
      fs.utimesSync(lockPath(dir), new Date(0), new Date(0));
      const result = await acquireDataDirLock(dir, { pid: 222, startTime: "t2", isRunning: unknown, waitMs: 0, unknownWaitMs: 20, intervalMs: 10 });
      expect(result.ok).toBe(true);
      expect(readLock().pid).toBe(222);
    });

    // The age check passed for one lock; whatever tryLock finds next must be
    // judged on its own, so a fresh lock written meanwhile is never removed.
    it("takes over only the exact lock content whose age was checked", () => {
      writeLock({ pid: 111, startTime: "old" });
      const checkedRaw = fs.readFileSync(lockPath(dir), "utf8");
      writeLock({ pid: 555, startTime: "fresh" });
      const other = tryLock(dir, { pid: 222, startTime: "t2", isRunning: unknown, takeOverUnknown: (raw) => raw === checkedRaw });
      expect(other).toMatchObject({ ok: false, unknown: true, holder: { pid: 555 } });
      expect(readLock().pid).toBe(555);

      writeLock({ pid: 111, startTime: "old" });
      expect(tryLock(dir, { pid: 222, startTime: "t2", isRunning: unknown, takeOverUnknown: (raw) => raw === checkedRaw }).ok).toBe(true);
    });

    it("lets only one of two launchers take over the same old lock", async () => {
      writeLock({ pid: 111, startTime: "old" });
      fs.utimesSync(lockPath(dir), new Date(0), new Date(0));
      const options = { isRunning: unknown, waitMs: 0, unknownWaitMs: 30, intervalMs: 5 };
      const [a, b] = await Promise.all([
        acquireDataDirLock(dir, { ...options, pid: 222, startTime: "ta" }),
        acquireDataDirLock(dir, { ...options, pid: 333, startTime: "tb" }),
      ]);
      expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
      const winner = a.ok ? 222 : 333;
      expect(readLock().pid).toBe(winner);
      expect((a.ok ? b : a)).toMatchObject({ ok: false, unknown: true, holder: { pid: winner } });
    });

    it("stops being retried as soon as the check works", async () => {
      writeLock({ pid: 111, startTime: "t1" });
      let calls = 0;
      const isRunning = () => (++calls < 3 ? UNKNOWN : false);
      const result = await acquireDataDirLock(dir, { pid: 222, startTime: "t2", isRunning, waitMs: 0, unknownWaitMs: 5000, intervalMs: 5 });
      expect(result.ok).toBe(true);
    });

    it("by default waits longer than one start-time probe can take", () => {
      const src = fs.readFileSync(path.resolve(import.meta.dirname, "../../cli/src/cli/utils/dataDirLock.js"), "utf8");
      expect(src).toMatch(/unknownWaitMs = 12000/);
      expect(src).toMatch(/timeout: 5000/);
    });
  });

  it("without its own start time, writes no lock but still refuses a live holder", () => {
    writeLock({ pid: 111, startTime: "t1" });
    expect(tryLock(dir, { pid: 222, startTime: null, isRunning: running([111, "t1"]) })).toMatchObject({ ok: false, holder: { pid: 111 } });
    fs.unlinkSync(lockPath(dir));
    const free = tryLock(dir, { pid: 222, startTime: null, isRunning: () => true });
    expect(free.ok).toBe(true);
    expect(fs.existsSync(lockPath(dir))).toBe(false);
    free.release();
  });

  it.skipIf(process.platform !== "linux")("reads its own start time once per acquire, however long it waits", async () => {
    writeLock({ pid: 111, startTime: "t1" });
    const read = fs.readFileSync;
    const ownStat = `/proc/${process.pid}/stat`;
    let reads = 0;
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation((file, ...rest) => {
      if (file === ownStat) reads++;
      return read(file, ...rest);
    });
    try {
      const result = await acquireDataDirLock(dir, { pid: 222, isRunning: running([111, "t1"]), waitMs: 60, intervalMs: 10 });
      expect(result.ok).toBe(false);
      expect(reads).toBe(1);
    } finally {
      spy.mockRestore();
    }
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

  const realStartTime = typeof processStartTime(process.pid) === "string";

  it.skipIf(!realStartTime)("locks against this process for real", () => {
    const mine = tryLock(dir);
    expect(mine.ok).toBe(true);
    expect(tryLock(dir, { pid: process.pid + 1, startTime: "other" })).toMatchObject({ ok: false, holder: { pid: process.pid } });
    mine.release();
  });

  // Same PID, different start time: the PID now belongs to another run.
  it.skipIf(!realStartTime)("treats a lock with this live PID but another start time as stale", () => {
    writeLock({ pid: process.pid, startTime: "lstart:Thu Jan  1 00:00:00 1970" });
    expect(holderRuns({ pid: process.pid, startTime: "lstart:Thu Jan  1 00:00:00 1970" })).toBe(false);
    const next = tryLock(dir, { pid: process.pid + 1, startTime: "other" });
    expect(next.ok).toBe(true);
    expect(readLock().pid).toBe(process.pid + 1);
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

  it("asks ps for lstart in UTC where there is no /proc", () => {
    const run = vi.fn(() => "Wed Nov 18 15:25:02 2026\n");
    expect(processStartTime(4242, { platform: "darwin", readFile: enoent, run })).toBe("lstart:Wed Nov 18 15:25:02 2026");
    expect(run).toHaveBeenCalledWith("ps", ["-p", "4242", "-o", "lstart="], expect.any(Object));
    // lstart is local time: a timezone change must not make a live holder look new.
    expect(run.mock.calls[0][2].env).toMatchObject({ TZ: "UTC", LC_ALL: "C" });
  });

  it("is null (no such process) when ps exits 1 or prints nothing", () => {
    const exit1 = () => { throw Object.assign(new Error("Command failed: ps"), { status: 1, signal: null }); };
    expect(processStartTime(4242, { platform: "darwin", readFile: enoent, run: exit1 })).toBeNull();
    expect(processStartTime(4242, { platform: "darwin", readFile: enoent, run: () => "\n" })).toBeNull();
  });

  it("is UNKNOWN when ps times out, is missing or fails otherwise", () => {
    const timeout = () => { throw Object.assign(new Error("spawnSync ps ETIMEDOUT"), { code: "ETIMEDOUT", signal: "SIGTERM", status: null }); };
    const missing = () => { throw Object.assign(new Error("spawnSync ps ENOENT"), { code: "ENOENT" }); };
    const other = () => { throw Object.assign(new Error("ps: bad option"), { status: 2 }); };
    for (const run of [timeout, missing, other]) {
      expect(processStartTime(4242, { platform: "darwin", readFile: enoent, run })).toBe(UNKNOWN);
    }
  });

  it("is UNKNOWN when /proc refuses to show the process", () => {
    const readFile = () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); };
    expect(processStartTime(4242, { platform: "linux", readFile, run: vi.fn() })).toBe(UNKNOWN);
  });

  it("uses the Win32 CreationDate on Windows, not just the image name", () => {
    const run = vi.fn(() => "2026-11-18T15:25:02.1234560Z\r\n");
    expect(processStartTime(4242, { platform: "win32", run })).toBe("2026-11-18T15:25:02.1234560Z");
    const [cmd, args] = run.mock.calls[0];
    expect(cmd).toBe("powershell.exe");
    expect(args.at(-1)).toContain("ProcessId=4242");
    expect(args.at(-1)).toContain("CreationDate");
    expect(processStartTime(4242, { platform: "win32", run: () => "" })).toBeNull();
    expect(processStartTime(4242, { platform: "win32", run: () => { throw new Error("timed out"); } })).toBe(UNKNOWN);
  });

  it("reports a holder whose start time can't be read as UNKNOWN, never stale", () => {
    expect(holderRuns({ pid: 4242, startTime: "t" }, () => UNKNOWN)).toBe(UNKNOWN);
    expect(holderRuns({ pid: 4242, startTime: "t" }, () => null)).toBe(false);
    expect(holderRuns({ pid: 4242, startTime: "t" }, () => "other")).toBe(false);
    expect(holderRuns({ pid: 4242, startTime: "t" }, () => "t")).toBe(true);
  });

  // hidepid: another user's process, which can't tell us anything.
  it("is UNKNOWN when /proc says EPERM", () => {
    const readFile = () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); };
    expect(processStartTime(4242, { platform: "linux", readFile, run: vi.fn() })).toBe(UNKNOWN);
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
    const cli = cliSource();
    expect(cli).toMatch(/^if \(process\.env\[AUTOSTART_ENV\] === "1" && process\.env\.DATA_DIR\) \{$/m);
    expect(cli).toMatch(/^ {2}const unsafe = unsafeDataDirReason\(process\.env\.DATA_DIR\);$/m);
  });
});
