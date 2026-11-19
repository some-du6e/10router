import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { writePrivateFile } from "../../src/lib/cliTools/privateFile.js";

const posix = process.platform !== "win32";
const modeOf = (file) => fs.statSync(file).mode & 0o777;
const errno = (code) => Object.assign(new Error(code), { code });

let dir;
let umask;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "10r-private-file-"));
  umask = process.umask(0o022);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.umask(umask);
  fs.rmSync(dir, { recursive: true, force: true });
});

const leftovers = () => fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));

describe.runIf(posix)("writePrivateFile", () => {
  it("creates a new file 0600", async () => {
    const file = path.join(dir, "config.json");
    await writePrivateFile(file, "secret");
    expect(fs.readFileSync(file, "utf8")).toBe("secret");
    expect(modeOf(file)).toBe(0o600);
    expect(leftovers()).toEqual([]);
  });

  it("replaces a world-readable file through a 0600 temp file", async () => {
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, "old", { mode: 0o644 });
    const inode = fs.statSync(file).ino;
    await writePrivateFile(file, "secret");
    expect(fs.readFileSync(file, "utf8")).toBe("secret");
    expect(modeOf(file)).toBe(0o600);
    expect(fs.statSync(file).ino).not.toBe(inode);
  });

  it.each(["EBUSY", "EXDEV", "EPERM"])(
    "falls back to an in-place write when rename fails with %s, tightening the file before the secret goes in",
    async (code) => {
      const file = path.join(dir, "bind-mounted.json");
      fs.writeFileSync(file, "old", { mode: 0o644 });
      const inode = fs.statSync(file).ino;
      vi.spyOn(fsp, "rename").mockRejectedValue(errno(code));
      const realWrite = fsp.writeFile.bind(fsp);
      const modesAtWrite = [];
      vi.spyOn(fsp, "writeFile").mockImplementation(async (target, ...rest) => {
        if (target === file) modesAtWrite.push(modeOf(file));
        return realWrite(target, ...rest);
      });

      await writePrivateFile(file, "secret");

      expect(fs.readFileSync(file, "utf8")).toBe("secret");
      expect(fs.statSync(file).ino).toBe(inode);
      expect(modeOf(file)).toBe(0o600);
      // The file was already owner-only when the secret was written into it.
      expect(modesAtWrite).toEqual([0o600]);
      expect(leftovers()).toEqual([]);
    }
  );

  it("doesn't write in place into a file it can't make owner-only", async () => {
    const file = path.join(dir, "not-mine.json");
    fs.writeFileSync(file, "old", { mode: 0o644 });
    vi.spyOn(fsp, "rename").mockRejectedValue(errno("EBUSY"));
    vi.spyOn(fsp, "chmod").mockImplementation(async (target, mode) => {
      if (target === file) throw errno("EPERM");
      return fs.chmodSync(target, mode);
    });
    await expect(writePrivateFile(file, "secret")).rejects.toThrow("EPERM");
    expect(fs.readFileSync(file, "utf8")).toBe("old");
    expect(leftovers()).toEqual([]);
  });

  it("other rename errors still fail, leaving the old file and no temp file", async () => {
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, "old");
    vi.spyOn(fsp, "rename").mockRejectedValue(errno("EACCES"));
    await expect(writePrivateFile(file, "secret")).rejects.toThrow("EACCES");
    expect(fs.readFileSync(file, "utf8")).toBe("old");
    expect(leftovers()).toEqual([]);
  });

  it("writes a dangling symlink's target and keeps the link", async () => {
    const real = path.join(dir, "dotfiles", "config.json");
    fs.mkdirSync(path.dirname(real));
    const link = path.join(dir, "config.json");
    fs.symlinkSync(path.join("dotfiles", "config.json"), link);
    await writePrivateFile(link, "secret");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, "utf8")).toBe("secret");
    expect(modeOf(real)).toBe(0o600);
  });

  it("run as root, gives the new file the old file's owner", async () => {
    const file = path.join(dir, "home-config.json");
    fs.writeFileSync(file, "old");
    const realStat = fsp.stat.bind(fsp);
    vi.spyOn(process, "getuid").mockReturnValue(0);
    vi.spyOn(fsp, "stat").mockImplementation(async (target) => {
      const st = await realStat(target);
      return target === file ? { ...st, uid: 1000, gid: 1000 } : st;
    });
    const chown = vi.spyOn(fsp, "chown").mockResolvedValue();
    await writePrivateFile(file, "secret");
    expect(chown).toHaveBeenCalledTimes(1);
    const [tmp, uid, gid] = chown.mock.calls[0];
    expect(path.dirname(tmp)).toBe(dir);
    expect(tmp).not.toBe(file);
    expect([uid, gid]).toEqual([1000, 1000]);
    expect(fs.readFileSync(file, "utf8")).toBe("secret");
  });

  it("run as root, gives a first-time file the directory's owner", async () => {
    const file = path.join(dir, "new-config.json");
    const realStat = fsp.stat.bind(fsp);
    vi.spyOn(process, "getuid").mockReturnValue(0);
    vi.spyOn(fsp, "stat").mockImplementation(async (target) => {
      const st = await realStat(target);
      return target === dir ? { ...st, uid: 1000, gid: 1001 } : st;
    });
    const chown = vi.spyOn(fsp, "chown").mockResolvedValue();
    await writePrivateFile(file, "secret");
    expect(chown).toHaveBeenCalledTimes(1);
    expect(chown.mock.calls[0].slice(1)).toEqual([1000, 1001]);
    expect(fs.readFileSync(file, "utf8")).toBe("secret");
    expect(modeOf(file)).toBe(0o600);
  });

  it("resolves a relative link against the directory it really sits in", async () => {
    // dir/real/sub/config.json -> ../target.json, reached as dir/alias/config.json
    // where dir/alias -> dir/real/sub. The link means dir/real/target.json.
    fs.mkdirSync(path.join(dir, "real", "sub"), { recursive: true });
    fs.symlinkSync(path.join("..", "target.json"), path.join(dir, "real", "sub", "config.json"));
    fs.symlinkSync(path.join(dir, "real", "sub"), path.join(dir, "alias"));
    await writePrivateFile(path.join(dir, "alias", "config.json"), "secret");
    expect(fs.readFileSync(path.join(dir, "real", "target.json"), "utf8")).toBe("secret");
    expect(fs.existsSync(path.join(dir, "target.json"))).toBe(false);
    expect(fs.lstatSync(path.join(dir, "real", "sub", "config.json")).isSymbolicLink()).toBe(true);
  });

  it("not root, never chowns", async () => {
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, "old");
    vi.spyOn(process, "getuid").mockReturnValue(1000);
    const chown = vi.spyOn(fsp, "chown");
    await writePrivateFile(file, "secret");
    expect(chown).not.toHaveBeenCalled();
  });
});
