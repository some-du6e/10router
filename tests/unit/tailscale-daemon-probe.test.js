import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@/lib/dataDir.js", () => ({ DATA_DIR: join(tmpdir(), `tailscale-probe-${randomUUID()}`) }));
const { isDaemonTunMode } = await import("../../src/lib/tunnel/tailscale/tailscale.js");

describe("Tailscale daemon process probe", () => {
  it.skipIf(process.platform === "win32")("does not mistake its own probe shell for a TUN daemon", () => {
    expect(isDaemonTunMode()).toBeNull();
  });
});
