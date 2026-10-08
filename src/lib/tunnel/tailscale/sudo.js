import { execSync, spawn } from "node:child_process";
import { loadHostPassword, saveHostPassword } from "@/lib/hostCredentials.js";

export function getCachedPassword() {
  return globalThis.__tailscaleSudoPassword || "";
}

export function setCachedPassword(password) {
  globalThis.__tailscaleSudoPassword = password;
}

export async function loadPassword() {
  return getCachedPassword() || await loadHostPassword("tailscale");
}

export async function rememberPassword(password) {
  validatePassword(password);
  if (password) await verifyPassword(password);
  await saveHostPassword("tailscale", password);
  setCachedPassword(password);
}

export function verifyPassword(password) {
  return execWithPassword("true", password, { forceAuthentication: true });
}

export function validatePassword(password) {
  if (password !== undefined && (typeof password !== "string" || /[\r\n\0]/.test(password))) {
    throw new Error("Invalid sudo password");
  }
}

export function execWithPassword(command, password, { forceAuthentication = false } = {}) {
  return new Promise((resolve, reject) => {
    let useSudo = false;
    try {
      execSync("command -v sudo", { stdio: "ignore", windowsHide: true });
      useSudo = true;
    } catch { /* Minimal containers may already run as root. */ }
    const child = spawn(useSudo ? "sudo" : "sh", useSudo ? ["-S", ...(forceAuthentication ? ["-k"] : []), "sh", "-c", command] : ["-c", command], {
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
