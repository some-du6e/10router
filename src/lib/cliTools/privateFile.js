import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

// Tool config files the CLI tools page writes hold a client key (and Cowork's the
// CLI token), so they are owner-only. The content goes to a 0600 temp file next to
// the target, which is then renamed over it: an existing world-readable file is
// never rewritten in place with the new secret, and a crash leaves the old file.
// A symlinked config (dotfiles repos) is written through to the file it points at.
export async function writePrivateFile(filePath, content, encoding = "utf-8") {
  let target = filePath;
  try {
    target = await fs.realpath(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  await fs.writeFile(tmp, content, { encoding, mode: 0o600, flag: "wx" });
  try {
    // The umask can only remove bits, but say it outright.
    if (process.platform !== "win32") await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, target);
  } catch (error) {
    await fs.unlink(tmp).catch(() => {});
    throw error;
  }
}
