import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const autostart = require("../../cli/src/cli/tray/autostart.js");
const { macLaunchAgent, windowsStartupScript, linuxDesktopEntry } = autostart;
const { handleClick, MENU_INDEX } = require("../../cli/src/cli/tray/tray.js");

const local = { host: "127.0.0.1", port: 20200 };

afterEach(() => vi.restoreAllMocks());

describe("autostart entries keep the chosen bind and port", () => {
  it("macOS launch agent passes --host and --port as separate arguments", () => {
    const plist = macLaunchAgent("/opt/node/bin/node", "/opt/10router/cli.js", local);
    expect(plist).toContain("<string>--port</string>\n        <string>20200</string>");
    expect(plist).toContain("<string>--host</string>\n        <string>127.0.0.1</string>");
  });

  it("escapes XML in macOS paths", () => {
    const plist = macLaunchAgent("/opt/a&b/node", "/opt/<x>/cli.js", local);
    expect(plist).toContain("<string>/opt/a&amp;b/node</string>");
    expect(plist).toContain("<string>/opt/&lt;x&gt;/cli.js</string>");
  });

  it("Windows startup script quotes every argument", () => {
    const vbs = windowsStartupScript("C:\\Program Files\\nodejs\\node.exe", "C:\\npm\\10router\\cli.js", local);
    expect(vbs).toContain('WshShell.Run """C:\\Program Files\\nodejs\\node.exe"" ""C:\\npm\\10router\\cli.js"" ""--tray"" ""--skip-update"" ""--port"" ""20200"" ""--host"" ""127.0.0.1""", 0, False');
  });

  it("Linux desktop entry quotes paths with spaces and keeps the bind", () => {
    const entry = linuxDesktopEntry("/node runtime/node", "/router folder/cli.js", local);
    expect(entry).toContain('Exec="/node runtime/node" "/router folder/cli.js" "--tray" "--skip-update" "--port" "20200" "--host" "127.0.0.1"');
  });

  it("Linux desktop entry escapes $, quotes, backslashes and %", () => {
    const entry = linuxDesktopEntry("/opt/$HOME/node", '/opt/a"b\\c 100%/cli.js', local);
    expect(entry).toContain('Exec="/opt/\\\\$HOME/node" "/opt/a\\\\"b\\\\\\\\c 100%%/cli.js"');
  });

  it("uses the default bind when no options are given", () => {
    expect(linuxDesktopEntry("/n", "/c", undefined)).toContain('"--port" "20128" "--host" "0.0.0.0"');
  });
});

describe("tray auto-start toggle", () => {
  it("enables auto-start with the running instance's host, port and cli path", () => {
    vi.spyOn(autostart, "isAutoStartEnabled").mockReturnValue(false);
    const enable = vi.spyOn(autostart, "enableAutoStart").mockReturnValue(true);
    const toggled = vi.fn();
    handleClick(MENU_INDEX.AUTOSTART, { port: 20200, host: "127.0.0.1", cliPath: "/opt/10router/cli.js" }, toggled);
    expect(enable).toHaveBeenCalledWith("/opt/10router/cli.js", { port: 20200, host: "127.0.0.1" });
    expect(toggled).toHaveBeenCalledWith(true);
  });
});
