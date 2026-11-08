import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";

const execSync = vi.fn();
vi.mock("child_process", () => ({ execSync, spawn: vi.fn() }));

const { collectAppPids } = await import("../../src/lib/appUpdater.js");

const INSTALL = path.resolve("/opt/node/lib/node_modules/10router");
const DATA = path.resolve("/home/me/.9router");
const uid = String(process.getuid());
const other = String(process.getuid() + 1);

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
      `  205 ${uid} sqlite3 ${DATA}/db.sqlite`,
      `  206 ${other} node ${INSTALL}/cli.js`,
      `  ${process.pid} ${uid} node ${INSTALL}/app/custom-server.js`,
    ].join("\n"));

    expect(collectAppPids().sort()).toEqual(["101", "102", "103"]);
  });
});
