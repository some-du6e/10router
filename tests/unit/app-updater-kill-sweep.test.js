import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const execSync = vi.fn();
vi.mock("child_process", () => ({ execSync, spawn: vi.fn() }));

const { collectAppPids } = await import("../../src/lib/appUpdater.js");

const INSTALL = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "10router-pkg-")));
fs.writeFileSync(path.join(INSTALL, "cli.js"), "");
const DATA = path.resolve("/home/me/.9router");
const uid = String(process.getuid?.() ?? 0);
const other = String(Number(uid) + 1);

describe("collectAppPids", () => {
  let cwd;
  beforeEach(() => {
    cwd = vi.spyOn(process, "cwd").mockReturnValue(path.join(INSTALL, "app"));
    vi.stubEnv("DATA_DIR", DATA);
  });
  afterEach(() => {
    cwd.mockRestore();
    vi.unstubAllEnvs();
    execSync.mockReset();
  });

  it("only picks this user's processes running from this install", () => {
    execSync.mockReturnValue([
      `  101 ${uid} node ${INSTALL}/cli.js --tray`,
      `  102 ${uid} ${DATA}/bin/cloudflared tunnel --url http://127.0.0.1:20128`,
      `  103 ${uid} ${DATA}/runtime/node_modules/systray2/traybin/tray_linux_release`,
      `  201 ${uid} next-server (v16.3.1)`,
      `  202 ${uid} /usr/bin/cloudflared tunnel run`,
      `  203 ${uid} node /srv/other/cli.js`,
      `  204 ${uid} vim /home/me/notes-10router.md`,
      `  207 ${uid} vim ${DATA}/bin/notes.txt`,
      `  208 ${uid} rsync -a ${INSTALL}/ /backup/`,
      `  205 ${uid} sqlite3 ${DATA}/db.sqlite`,
      `  206 ${other} node ${INSTALL}/cli.js`,
      `  ${process.pid} ${uid} node ${INSTALL}/app/custom-server.js`,
    ].join("\n"));

    expect(collectAppPids().sort()).toEqual(["101", "102", "103"]);
  });

  it("treats /app as the root itself, not its parent, outside the CLI layout", () => {
    cwd.mockReturnValue(path.resolve("/app"));
    execSync.mockReturnValue([
      `  301 ${uid} curl -fsS http://127.0.0.1:20128/api/health`,
      `  302 ${uid} /usr/bin/cloudflared --url http://127.0.0.1:20128`,
      `  303 ${uid} node /app/worker.js`,
    ].join("\n"));

    expect(collectAppPids()).toEqual(["303"]);
  });

  it("parses Windows CSV output with CRLF line endings", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      execSync.mockReturnValue([
        `"ProcessId","CommandLine"`,
        `"401","""C:\\Program Files\\nodejs\\node.exe"" ""${INSTALL}/cli.js"" --tray"`,
        `"402","""${DATA}/bin/cloudflared.exe"" tunnel run"`,
        `"403","notepad.exe ${DATA}/bin/notes.txt"`,
        `"404",""`,
      ].join("\r\n") + "\r\n");

      expect(collectAppPids().sort()).toEqual(["401", "402"]);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });
});
