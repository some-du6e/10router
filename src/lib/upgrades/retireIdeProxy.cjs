// Upgrade-only cleanup. This file never creates certificates or redirects traffic.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const HOSTS = new Set([
  "daily-cloudcode-pa.googleapis.com", "cloudcode-pa.googleapis.com",
  "api.individual.githubcopilot.com", "runtime.us-east-1.kiro.dev",
  "q.us-east-1.amazonaws.com", "codewhisperer.us-east-1.amazonaws.com", "api2.cursor.sh",
]);

function removeRedirects(content) {
  // Only remove exact historical loopback mappings; preserve comments and other aliases.
  return content.split(/(?<=\n)/).map((line) => {
    const match = line.match(/^(\s*)127\.0\.0\.1[\t ]+([^#\r\n]+)(#[^\r\n]*)?(\r?\n)?$/);
    if (!match) return line;
    const names = match[2].trim().split(/\s+/);
    const remaining = names.filter((host) => !HOSTS.has(host.toLowerCase()));
    if (remaining.length === names.length) return line;
    const comment = match[3] || "";
    const newline = match[4] || "";
    return remaining.length
      ? `${match[1]}127.0.0.1 ${remaining.join(" ")}${comment ? ` ${comment}` : ""}${newline}`
      : comment ? `${match[1]}${comment}${newline}` : "";
  }).join("");
}

function getCommandLine(pid) {
  if (process.platform === "linux") {
    try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim(); }
    catch (error) { if (error.code === "ENOENT") return ""; throw error; }
  }
  if (process.platform === "win32") {
    return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`], { encoding: "utf8", windowsHide: true, timeout: 5000 }).trim();
  }
  try { return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 3000 }).trim(); }
  catch (error) { if (error.status === 1) return ""; throw error; }
}

function isHistoricalProxy(command, dataDir, appRoot) {
  if (!command) return false;
  const executable = command.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const name = (executable?.[1] || executable?.[2] || executable?.[3] || "").split(/[\\/]/).pop();
  if (!/^(?:node(?:\.exe)?|sudo|sh)$/i.test(name)) return false;
  const candidates = [path.join(dataDir, "runtime", "mitm", "server.js"), path.join(appRoot, "src", "mitm", "server.js")];
  const argumentsText = command.slice(executable[0].length).trim();
  return candidates.some((candidate) => {
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const flags = process.platform === "win32" ? "i" : "";
    if (/^node/i.test(name)) return new RegExp(`^["']?${escaped}["']?$`, flags).test(argumentsText);
    const prefix = name === "sudo" ? /^-S -E sh -c HOME=/ : /^-c HOME=/;
    if (!prefix.test(argumentsText)) return false;
    return new RegExp(`NODE_ENV=production\\s+['"][^'"]*[\\\\/]node['"]\\s+['"]${escaped}['"]$`, flags).test(argumentsText);
  });
}

function listProcesses() {
  if (process.platform === "win32") {
    const output = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
    const rows = output.trim() ? JSON.parse(output) : [];
    return (Array.isArray(rows) ? rows : [rows]).map((row) => ({ pid: row.ProcessId, command: row.CommandLine }));
  }
  return execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", timeout: 5000 }).split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), command: match[2] }] : [];
  });
}

function systemHostsPath() {
  return process.platform === "win32"
    ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "drivers", "etc", "hosts")
    : "/etc/hosts";
}

async function retire({ dataDir, appRoot, hostsPath = systemHostsPath(), commandLine = getCommandLine, processes = listProcesses, kill = process.kill.bind(process), wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), apply = false }) {
  const pidFile = path.join(dataDir, "mitm", ".mitm.pid");
  let pid = 0;
  try {
    const value = fs.readFileSync(pidFile, "utf8").trim();
    if (/^\d+$/.test(value)) pid = Number(value);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const command = Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid ? commandLine(pid) : "";
  const pids = new Set(processes().filter((entry) => entry.pid > 1 && entry.pid !== process.pid && isHistoricalProxy(entry.command, dataDir, appRoot)).map((entry) => entry.pid));
  if (isHistoricalProxy(command, dataDir, appRoot)) pids.add(pid);
  const proxyRunning = pids.size > 0;
  const content = fs.readFileSync(hostsPath, "utf8");
  const redirects = removeRedirects(content) !== content;
  if (!apply) return { needed: redirects || proxyRunning, redirects, proxyRunning };

  for (const pid of pids) {
    // Recheck the identity immediately before each signal to avoid recycled PIDs.
    if (isHistoricalProxy(commandLine(pid), dataDir, appRoot)) {
      try { kill(pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      if (!isHistoricalProxy(commandLine(pid), dataDir, appRoot)) break;
      await wait(100);
    }
    if (isHistoricalProxy(commandLine(pid), dataDir, appRoot)) kill(pid, "SIGKILL");
  }
  // The old process may have cleaned the hosts file itself during SIGTERM.
  const latest = fs.readFileSync(hostsPath, "utf8");
  const cleaned = removeRedirects(latest);
  if (cleaned !== latest) fs.writeFileSync(hostsPath, cleaned);
  try { fs.unlinkSync(pidFile); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (cleaned !== latest && hostsPath === systemHostsPath()) {
    try {
      if (process.platform === "win32") execFileSync("ipconfig", ["/flushdns"], { stdio: "ignore", windowsHide: true, timeout: 5000 });
      else if (process.platform === "darwin") {
        execFileSync("dscacheutil", ["-flushcache"], { stdio: "ignore", timeout: 3000 });
        execFileSync("killall", ["-HUP", "mDNSResponder"], { stdio: "ignore", timeout: 3000 });
      } else execFileSync("resolvectl", ["flush-caches"], { stdio: "ignore", timeout: 3000 });
    } catch { /* Not all operating systems run a DNS cache. */ }
  }
  return { needed: false, redirects: false, proxyRunning: false };
}

module.exports = { removeRedirects, isHistoricalProxy, retire };

if (require.main === module) {
  const [mode, dataDir, appRoot] = process.argv.slice(2);
  if (!["--inspect", "--apply"].includes(mode) || !dataDir || !appRoot) process.exit(2);
  retire({ dataDir, appRoot, apply: mode === "--apply" })
    .then((result) => process.stdout.write(JSON.stringify(result)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
