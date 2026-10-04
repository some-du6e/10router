import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { DATA_DIR } from "@/lib/dataDir.js";
import { loadHostPassword, saveHostPassword } from "@/lib/hostCredentials.js";

const execFileAsync = promisify(execFile);
let pending;

export function quoteWindowsArgument(value) {
  // Start-Process joins ArgumentList into a command line parsed with Windows quoting rules.
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

async function runCleanup() {
  const appRoot = process.cwd();
  const script = path.join(appRoot, "src", "lib", "upgrades", "retireIdeProxy.cjs");
  const args = [script, "--apply", DATA_DIR, appRoot];
  try {
    const { stdout } = await execFileAsync(process.execPath, [script, "--inspect", DATA_DIR, appRoot], { timeout: 10000, windowsHide: true });
    if (!JSON.parse(stdout).needed) {
      await saveHostPassword("retiredProxy", "");
      return;
    }
  } catch { /* Inspection may require elevation to read a privileged process. */ }

  try {
    await execFileAsync(process.execPath, args, { timeout: 15000, windowsHide: true });
  } catch {
    if (process.platform === "win32") {
      const quote = (value) => `'${value.replace(/'/g, "''")}'`;
      const argumentsString = args.map(quoteWindowsArgument).join(" ");
      const command = `$p = Start-Process -FilePath ${quote(process.execPath)} -ArgumentList ${quote(argumentsString)} -Verb RunAs -Wait -PassThru; exit $p.ExitCode`;
      await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", command], { timeout: 60000, windowsHide: true });
    } else {
      const password = await loadHostPassword("retiredProxy");
      await new Promise((resolve, reject) => {
        const child = spawn("sudo", [password ? "-S" : "-n", process.execPath, ...args], {
          stdio: ["pipe", "ignore", "pipe"], windowsHide: true, timeout: 15000,
        });
        let stderr = "";
        child.stderr.on("data", (data) => { stderr += data; });
        child.on("error", reject);
        child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || "Elevation required")));
        child.stdin.on("error", reject);
        child.stdin.end(password ? `${password}\n` : "");
      });
    }
  }
  await saveHostPassword("retiredProxy", "");
  console.log("[Upgrade] Removed legacy IDE proxy redirects and process.");
}

export function retireIdeProxy() {
  return pending ??= runCleanup().catch((error) => {
    pending = null;
    console.error("[Upgrade] Legacy proxy cleanup needs elevation. Restart 10router as administrator/root to remove old redirects:", error.message);
    throw error;
  });
}
