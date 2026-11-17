import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

// Tool config files the CLI tools page writes hold a client key (and Cowork's the
// CLI token), so they are owner-only. The content goes to a 0600 temp file next to
// the target, which is then renamed over it: an existing world-readable file is
// never rewritten in place with the new secret, and a crash leaves the old file.
//
// - A symlinked config (dotfiles repos) is written through to the file it points
//   at, a dangling link included, so the link stays a link.
// - Run as root (a container writing a mounted home), the new file keeps the old
//   file's owner, so the tool's user can still read it.
// - Where a rename can't replace the target (a single-file bind mount: EBUSY or
//   EXDEV; Windows with the file open: EPERM), the file is written in place,
//   after it is made owner-only.

const IN_PLACE_FALLBACK_CODES = new Set(["EBUSY", "EXDEV", "EPERM"]);
const isWindows = () => process.platform === "win32";

// The file a write should land in: the target, or what its symlink chain points at.
async function resolveTarget(filePath) {
  let target = filePath;
  for (let hops = 0; hops < 40; hops++) {
    let link;
    try {
      link = await fs.readlink(target);
    } catch (error) {
      // EINVAL: not a link. ENOENT: nothing there yet. Either way, write here.
      if (error?.code === "EINVAL" || error?.code === "ENOENT" || error?.code === "UNKNOWN") return target;
      throw error;
    }
    target = path.resolve(path.dirname(target), link);
  }
  throw Object.assign(new Error(`Too many symbolic links: ${filePath}`), { code: "ELOOP" });
}

async function statOrNull(target) {
  try {
    return await fs.stat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeInPlace(target, content, encoding) {
  // Owner-only before the new content goes in, so the file never holds the
  // secret while still world-readable. A file we can't tighten isn't written.
  if (!isWindows()) await fs.chmod(target, 0o600);
  await fs.writeFile(target, content, { encoding });
}

export async function writePrivateFile(filePath, content, encoding = "utf-8") {
  const target = await resolveTarget(filePath);
  const existing = await statOrNull(target);
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  await fs.writeFile(tmp, content, { encoding, mode: 0o600, flag: "wx" });
  try {
    // The umask can only remove bits, but say it outright.
    if (!isWindows()) await fs.chmod(tmp, 0o600);
    const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;
    if (existing && runningAsRoot && (existing.uid !== 0 || existing.gid !== 0)) {
      await fs.chown(tmp, existing.uid, existing.gid);
    }
    try {
      await fs.rename(tmp, target);
    } catch (error) {
      if (!existing || !IN_PLACE_FALLBACK_CODES.has(error?.code)) throw error;
      await fs.unlink(tmp).catch(() => {});
      await writeInPlace(target, content, encoding);
    }
  } catch (error) {
    await fs.unlink(tmp).catch(() => {});
    throw error;
  }
}
