import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const autostart = require("../../cli/src/cli/tray/autostart.js");
const { enableAutoStart, isAutoStartEnabled, migrateMacLogs, macLaunchAgent, windowsStartupScript, linuxDesktopEntry } = autostart;

const launch = { host: "127.0.0.1", port: 20200, dataDir: "/srv/router data" };
const logs = { out: "/u/Library/Logs/10router/10router.log", err: "/u/Library/Logs/10router/10router.error.log" };

// An in-memory machine: files written, modes set, commands run.
function fakeSystem(platform, { existing = [], files: initial = {}, owners = {}, fds = {} } = {}) {
  const files = new Map(Object.entries(initial));
  const dirs = new Set();
  const modes = new Map();
  const present = new Set(existing);
  const fsFake = {
    existsSync: (p) => present.has(p) || files.has(p) || dirs.has(p),
    mkdirSync: (p) => { dirs.add(p); },
    readFileSync: (p) => { if (!files.has(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return files.get(p); },
    writeFileSync: (p, data) => { files.set(p, data); },
    openSync: (p) => { if (!files.has(p)) files.set(p, ""); return 3; },
    closeSync: () => {},
    chmodSync: (p, mode) => { modes.set(p, mode); },
    lstatSync: (p) => {
      if (!files.has(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      // Each path is its own inode on device 1.
      return { isFile: () => true, uid: owners[p] ?? 501, dev: 1, ino: [...p].reduce((n, ch) => n * 31 + ch.charCodeAt(0), 7) % 1e9 };
    },
    fstatSync: (fd) => {
      if (!(fd in fds)) throw Object.assign(new Error("EBADF"), { code: "EBADF" });
      return fds[fd];
    },
    unlinkSync: (p) => { files.delete(p); },
  };
  const execSync = vi.fn(() => "");
  return {
    sys: {
      platform,
      pid: 4242,
      uid: 501,
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
    expect(plist).toContain("<key>TENROUTER_AUTOSTART</key>\n        <string>1</string>");
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
    expect(vbs).toContain('ProcessEnv("TENROUTER_AUTOSTART") = "1"');
    expect(vbs).toContain('""--port"" ""20200"" ""--host"" ""127.0.0.1""');
  });

  it("Linux: the desktop entry runs env DATA_DIR=... with the bind and port", () => {
    const m = fakeSystem("linux", { existing: ["/opt/10router/cli.js"] });
    expect(enableAutoStart("/opt/10router/cli.js", launch, m.sys)).toBe(true);
    const entry = m.files.get("/home/me/.config/autostart/10router.desktop");
    expect(entry).toContain('Exec="env" "TENROUTER_AUTOSTART=1" "DATA_DIR=/srv/router data" "/opt/node/bin/node" "/opt/10router/cli.js" "--tray" "--skip-update" "--port" "20200" "--host" "127.0.0.1"');
  });

  it("leaves DATA_DIR out when the launcher uses the default", () => {
    const m = fakeSystem("linux", { existing: ["/opt/10router/cli.js"] });
    enableAutoStart("/opt/10router/cli.js", { ...launch, dataDir: "" }, m.sys);
    expect(m.files.get("/home/me/.config/autostart/10router.desktop")).toContain('Exec="env" "TENROUTER_AUTOSTART=1" "/opt/node/bin/node"');
  });

  it.each(["linux", "darwin", "win32"])("%s: writes nothing for a DATA_DIR with a line break", (platform) => {
    const cli = platform === "win32" ? "C:\\npm\\10router\\cli.js" : "/opt/10router/cli.js";
    const startup = "C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup";
    const m = fakeSystem(platform, { existing: [cli, startup] });
    expect(enableAutoStart(cli, { ...launch, dataDir: "/srv/a\nExec=evil" }, m.sys)).toBe(false);
    expect([...m.files.keys()].filter((f) => /\.(desktop|plist|vbs)$/.test(f))).toEqual([]);
  });
});

describe("LaunchAgents written by an older 10router", () => {
  const plistPath = "/home/me/Library/LaunchAgents/com.10router.autostart.plist";
  const oldPlist = [
    "<key>StandardOutPath</key>", "<string>/tmp/10router.log</string>",
    "<key>StandardErrorPath</key>", "<string>/tmp/10router.error.log</string>",
  ].join("\n");

  it("moves the logs out of /tmp and deletes the old world-readable ones", () => {
    const m = fakeSystem("darwin", { files: { [plistPath]: oldPlist, "/tmp/10router.log": "token", "/tmp/10router.error.log": "" } });
    expect(migrateMacLogs(m.sys)).toBe(true);
    const plist = m.files.get(plistPath);
    expect(plist).toContain("<string>/home/me/Library/Logs/10router/10router.log</string>");
    expect(plist).toContain("<string>/home/me/Library/Logs/10router/10router.error.log</string>");
    expect(plist).not.toContain("/tmp/");
    expect(m.files.has("/tmp/10router.log")).toBe(false);
    expect(m.files.has("/tmp/10router.error.log")).toBe(false);
    expect(m.modes.get("/home/me/Library/Logs/10router/10router.log")).toBe(0o600);
    expect(m.execSync).not.toHaveBeenCalled();
  });

  // Started by that old agent, this process still writes its stdout there.
  it("makes a /tmp log this process is writing to private instead of deleting it", () => {
    const probe = fakeSystem("darwin", { files: { "/tmp/10router.log": "" } });
    const out = probe.sys.fs.lstatSync("/tmp/10router.log");
    const m = fakeSystem("darwin", {
      files: { [plistPath]: oldPlist, "/tmp/10router.log": "token", "/tmp/10router.error.log": "" },
      fds: { 1: { dev: out.dev, ino: out.ino }, 2: { dev: 9, ino: 9 } },
    });
    expect(migrateMacLogs(m.sys)).toBe(true);
    expect(m.files.has("/tmp/10router.log")).toBe(true);
    expect(m.modes.get("/tmp/10router.log")).toBe(0o600);
    expect(m.files.has("/tmp/10router.error.log")).toBe(false);
  });

  it("leaves a /tmp file another user owns alone", () => {
    const m = fakeSystem("darwin", { files: { [plistPath]: oldPlist, "/tmp/10router.log": "theirs" }, owners: { "/tmp/10router.log": 0 } });
    migrateMacLogs(m.sys);
    expect(m.files.get("/tmp/10router.log")).toBe("theirs");
  });

  it("does nothing for a current plist, without a plist, or off macOS", () => {
    const current = fakeSystem("darwin", { files: { [plistPath]: "<string>/home/me/Library/Logs/10router/10router.log</string>" } });
    expect(migrateMacLogs(current.sys)).toBe(false);
    expect(migrateMacLogs(fakeSystem("darwin").sys)).toBe(false);
    expect(migrateMacLogs(fakeSystem("linux", { files: { [plistPath]: oldPlist } }).sys)).toBe(false);
  });

  it("runs at every launcher start", () => {
    const cli = fs.readFileSync(path.resolve(import.meta.dirname, "../../cli/cli.js"), "utf8").replace(/\r\n/g, "\n");
    expect(cli).toMatch(/^try \{ migrateMacLogs\(\); \} catch \{ \}$/m);
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
    const tray = fs.readFileSync(path.resolve(import.meta.dirname, "../../cli/src/cli/tray/tray.js"), "utf8").replace(/\r\n/g, "\n");
    expect(tray).toMatch(/^\s*else enableAutoStart\(options\.cliPath, options\.autostart\);$/m);
  });
});
