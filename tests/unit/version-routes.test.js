import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const updater = vi.hoisted(() => ({
  busy: [],
  busyInstallPids: vi.fn(),
  killAppProcesses: vi.fn(async () => {}),
  spawnUpdaterAndExit: vi.fn(),
}));
vi.mock("@/lib/appUpdater", () => ({
  busyInstallPids: (...args) => updater.busyInstallPids(...args),
  busyInstallMessage: (pids) => `Another 10router from this install is running (PID ${pids.join(", ")}); stop it, then update.`,
  killAppProcesses: (...args) => updater.killAppProcesses(...args),
  spawnUpdaterAndExit: (...args) => updater.spawnUpdaterAndExit(...args),
}));

const { POST: update } = await import("../../src/app/api/version/update/route.js");
const { POST: shutdown } = await import("../../src/app/api/version/shutdown/route.js");

let exit;
beforeEach(() => {
  // Only the exit timer: reading a Response body needs the real event loop.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  exit = vi.spyOn(process, "exit").mockImplementation(() => undefined);
  updater.busyInstallPids.mockImplementation(() => updater.busy);
  updater.killAppProcesses.mockClear();
  updater.spawnUpdaterAndExit.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  exit.mockRestore();
  vi.unstubAllEnvs();
  updater.busy = [];
});

describe("POST /api/version/update", () => {
  it("refuses with 409 while another copy of this install runs, before stopping anything", async () => {
    vi.stubEnv("NODE_ENV", "production");
    updater.busy = [7100];

    const res = await update();

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      success: false,
      message: "Another 10router from this install is running (PID 7100); stop it, then update.",
    });
    expect(updater.killAppProcesses).not.toHaveBeenCalled();
    expect(updater.spawnUpdaterAndExit).not.toHaveBeenCalled();
  });

  it("stops this install's processes and starts the updater when nothing else runs", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const res = await update();

    expect(res.status).toBe(200);
    expect(updater.killAppProcesses).toHaveBeenCalledTimes(1);
    expect(updater.spawnUpdaterAndExit).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/version/shutdown", () => {
  it("still shuts down, with a warning naming the other copy", async () => {
    updater.busy = [7100];

    const res = await shutdown();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.warning).toBe("Another 10router from this install is running (PID 7100); stop it, then update.");
    expect(updater.killAppProcesses).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("logs why it is about to exit, before the exit", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await shutdown();

      expect(log).toHaveBeenCalledWith("[Shutdown] the dashboard asked to stop for a manual update: exiting in 500 ms");
      expect(exit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(500);
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      log.mockRestore();
    }
  });

  it("has no warning key when nothing else runs", async () => {
    const res = await shutdown();

    const body = await res.json();
    expect(body).not.toHaveProperty("warning");
    expect(updater.killAppProcesses).toHaveBeenCalledTimes(1);
  });
});
