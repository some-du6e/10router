import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const autostart = require("../../cli/src/cli/tray/autostart.js");
const { enableAutoStart, isAutoStartEnabled, macLaunchAgent, windowsStartupScript, linuxDesktopEntry } = autostart;

const launch = { host: "127.0.0.1", port: 20200, dataDir: "/srv/router data" };
const logs = { out: "/u/Library/Logs/10router/10router.log", err: "/u/Library/Logs/10router/10router.error.log" };

// An in-memory machine: files written, modes set, commands run.
function fakeSystem(platform, { existing = [] } = {}) {
  const files = new Map();
  const dirs = new Set();
  const modes = new Map();
  const present = new Set(existing);
  const fsFake = {
    existsSync: (p) => present.has(p) || files.has(p) || dirs.has(p),
    mkdirSync: (p) => { dirs.add(p); },
    writeFileSync: (p, data) => { files.set(p, data); },
    openSync: (p) => { if (!files.has(p)) files.set(p, ""); return 3; },
    closeSync: () => {},
    chmodSync: (p, mode) => { modes.set(p, mode); },
    unlinkSync: (p) => { files.delete(p); },
  };
  const execSync = vi.fn(() => "");
  return {
    sys: {
      platform,
      pid: 4242,
      execPath: platform === "win32" ? "C:\\Program Files\\nodejs\\node.exe" : "/opt/node/bin/node",
      argv1: "",
      env: { DISPLAY: ":0", APPDATA: "C:\\Users\\me\\AppData\\Roaming" },
      homedir: platform === "win32" ? "C:\\Users\\me" : "/home/me",
      fs: fsFake,
      execSync,
    },
    files, modes, execSync,
  };
}

describe("enabling autostart writes an entry that restarts the same instance", () => {
  it("macOS: plist carries the bind, port and DATA_DIR, logs go to a private folder, and nothing is loaded now", () => {
    const m = fakeSystem("darwin", { existing: ["/opt/10router/cli.js"] });
    expect(enableAutoStart("/opt/10router/cli.js", launch, m.sys)).toBe(true);
    const plist = m.files.get("/home/me/Library/LaunchAgents/com.10router.autostart.plist");
    expect(plist).toContain("<string>--port</string>\n        <string>20200</string>");
    expect(plist).toContain("<string>--host</string>\n        <string>127.0.0.1</string>");
    expect(plist).toContain("<key>DATA_DIR</key>\n        <string>/srv/router data</string>");
    expect(plist).toContain("<string>/home/me/Library/Logs/10router/10router.log</string>");
    expect(plist).not.toContain("/tmp/");
    expect(m.modes.get("/home/me/Library/Logs/10router")).toBe(0o700);
    expect(m.modes.get("/home/me/Library/Logs/10router/10router.log")).toBe(0o600);
    expect(m.modes.get("/home/me/Library/Logs/10router/10router.error.log")).toBe(0o600);
    // RunAtLoad would start a second instance next to this one.
    expect(m.execSync).not.toHaveBeenCalled();
    expect(isAutoStartEnabled(m.sys)).toBe(true);
  });

  it("Windows: a UTF-16LE startup script that sets DATA_DIR and quotes every argument", () => {
    const startup = "C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup";
    const m = fakeSystem("win32", { existing: [startup, "C:\\npm\\10router\\cli.js"] });
    expect(enableAutoStart("C:\\npm\\10router\\cli.js", { ...launch, dataDir: "D:\\Données\\10router" }, m.sys)).toBe(true);
    const data = m.files.get(`${startup}\\10router.vbs`);
    expect([...data.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    const vbs = data.subarray(2).toString("utf16le");
    expect(vbs).toContain('ProcessEnv("DATA_DIR") = "D:\\Données\\10router"');
    expect(vbs).toContain('""--port"" ""20200"" ""--host"" ""127.0.0.1""');
  });

  it("Linux: the desktop entry runs env DATA_DIR=... with the bind and port", () => {
    const m = fakeSystem("linux", { existing: ["/opt/10router/cli.js"] });
    expect(enableAutoStart("/opt/10router/cli.js", launch, m.sys)).toBe(true);
    const entry = m.files.get("/home/me/.config/autostart/10router.desktop");
    expect(entry).toContain('Exec="env" "DATA_DIR=/srv/router data" "/opt/node/bin/node" "/opt/10router/cli.js" "--tray" "--skip-update" "--port" "20200" "--host" "127.0.0.1"');
  });

  it("leaves DATA_DIR out when the launcher uses the default", () => {
    const m = fakeSystem("linux", { existing: ["/opt/10router/cli.js"] });
    enableAutoStart("/opt/10router/cli.js", { ...launch, dataDir: "" }, m.sys);
    expect(m.files.get("/home/me/.config/autostart/10router.desktop")).toContain('Exec="/opt/node/bin/node"');
  });
});

describe("autostart escaping", () => {
  it("escapes &, <, >, \" and ' in the plist", () => {
    const plist = macLaunchAgent("/opt/a&b/node", "/opt/<x>/it's \"cli\".js", launch, logs);
    expect(plist).toContain("<string>/opt/a&amp;b/node</string>");
    expect(plist).toContain("<string>/opt/&lt;x&gt;/it&apos;s &quot;cli&quot;.js</string>");
  });

  it("Windows: a quote in an argument uses command-line escaping, then VBScript doubling", () => {
    const vbs = windowsStartupScript("C:\\node.exe", 'C:\\a"b\\cli.js', launch);
    // Command line: "C:\a\"b\cli.js"; in a VBScript string each " is doubled.
    expect(vbs).toContain('""C:\\a\\""b\\cli.js""');
  });

  it("Windows: backslashes before a closing quote are doubled", () => {
    const vbs = windowsStartupScript("C:\\node.exe", "C:\\dir\\", launch);
    expect(vbs).toContain('""C:\\dir\\\\""');
  });

  it("Windows: % is written through %TENROUTER_PCT% so WshShell.Run doesn't expand it", () => {
    const vbs = windowsStartupScript("C:\\node.exe", "C:\\100%PATH%\\cli.js", launch);
    expect(vbs).toContain('ProcessEnv("TENROUTER_PCT") = "%"');
    // Expanded in one pass, this becomes C:\100%PATH%\cli.js again.
    expect(vbs).toContain('""C:\\100%TENROUTER_PCT%PATH%TENROUTER_PCT%\\cli.js""');
  });

  it("Linux: escapes $, quotes, backticks, backslashes and %", () => {
    const entry = linuxDesktopEntry("/opt/$HOME/node", '/opt/a"b\\c `x` 100%/cli.js', launch);
    expect(entry).toContain('"/opt/\\\\$HOME/node" "/opt/a\\\\"b\\\\\\\\c \\\\`x\\\\` 100%%/cli.js"');
  });
});

describe("tray auto-start toggle", () => {
  it("enables autostart with the launch options cli.js passed in", () => {
    const tray = fs.readFileSync(path.resolve(import.meta.dirname, "../../cli/src/cli/tray/tray.js"), "utf8");
    expect(tray).toMatch(/^\s*else enableAutoStart\(options\.cliPath, options\.autostart\);$/m);
  });
});
