// Upgrade-only cleanup for the removed Token Saver: stop a Headroom proxy that
// an older version started detached, then delete its and PXPIPE's data dirs.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DATA_DIR } from "@/lib/dataDir.js";

function commandLine(pid) {
  if (process.platform === "linux") {
    try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim(); }
    catch { return ""; }
  }
  if (process.platform === "win32") {
    return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`], { encoding: "utf8", windowsHide: true, timeout: 5000 }).trim();
  }
  try { return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 3000 }).trim(); }
  catch { return ""; }
}

export function isHeadroomProxy(command) {
  return /(^|[\\/\s"'])headroom(\.exe)?["']?\s+proxy(\s|$)/i.test(command || "");
}

export function retireTokenSaver({ dataDir = DATA_DIR, getCommandLine = commandLine, kill = process.kill.bind(process) } = {}) {
  const headroomDir = path.join(dataDir, "headroom");
  try {
    const pid = Number(fs.readFileSync(path.join(headroomDir, "proxy.pid"), "utf8").trim());
    if (Number.isInteger(pid) && pid > 0 && isHeadroomProxy(getCommandLine(pid))) kill(pid, "SIGTERM");
  } catch { /* no pid file or process already gone */ }
  for (const dir of [headroomDir, path.join(dataDir, "pxpipe")]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
