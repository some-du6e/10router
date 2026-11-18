import { describe, expect, it } from "vitest";
import { buildRelaunchArgs, dialHostForBind, serverBind } from "../../src/lib/appUpdater.js";

const launched = { TENROUTER_LAUNCHER_PID: "4321", PORT: "20200", HOSTNAME: "127.0.0.1" };

describe("dashboard update relaunch", () => {
  it("brings a --host/--port launch back on the same address", () => {
    expect(buildRelaunchArgs(launched)).toEqual(["10router", "--skip-update", "--port", "20200", "--host", "127.0.0.1"]);
    expect(buildRelaunchArgs({ ...launched, TRAY_MODE: "1" })).toEqual(["10router", "--tray", "--skip-update", "--port", "20200", "--host", "127.0.0.1"]);
  });

  // Without the launcher, HOSTNAME is usually the machine's name.
  it("ignores HOSTNAME when the server wasn't started by the CLI launcher", () => {
    expect(serverBind({ PORT: "20200", HOSTNAME: "build-box" })).toEqual({ port: 20200, host: "" });
    expect(buildRelaunchArgs({ PORT: "20200", HOSTNAME: "build-box" })).not.toContain("--host");
  });

  it("falls back to the default port", () => {
    expect(serverBind({})).toEqual({ port: 20128, host: "" });
  });

  it("waits on the address the server is reachable at", () => {
    expect(dialHostForBind("")).toBe("127.0.0.1");
    expect(dialHostForBind("0.0.0.0")).toBe("127.0.0.1");
    expect(dialHostForBind("::")).toBe("::1");
    expect(dialHostForBind("192.168.1.5")).toBe("192.168.1.5");
  });
});
