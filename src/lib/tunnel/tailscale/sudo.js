import { execSync, spawn } from "node:child_process";

export function getCachedPassword() {
  return globalThis.__tailscaleSudoPassword || "";
}

export function setCachedPassword(password) {
  globalThis.__tailscaleSudoPassword = password;
}

export function execWithPassword(command, password) {
  return new Promise((resolve, reject) => {
    let useSudo = false;
    try {
      execSync("command -v sudo", { stdio: "ignore", windowsHide: true });
      useSudo = true;
    } catch { /* Minimal containers may already run as root. */ }
    const child = spawn(useSudo ? "sudo" : "sh", useSudo ? ["-S", "sh", "-c", command] : ["-c", command], {
      stdio: [useSudo ? "pipe" : "ignore", "pipe", "pipe"], windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `Exit code ${code}`));
    });
    if (useSudo) {
      child.stdin.on("error", reject);
      child.stdin.end(`${password || ""}\n`);
    }
  });
}
