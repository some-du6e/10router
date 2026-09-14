import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// getPxpipeStats buckets events into a daily timeline. The buckets start at
// LOCAL midnight, so the per-event key must be local too. Keying with
// toISOString() (UTC) silently dropped every event inside the UTC-offset
// window — in Europe/Berlin, everything after 22:00/23:00 local.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pxpipe-tz-"));

vi.mock("../../src/lib/pxpipe/install.js", () => ({ PXPIPE_DIR: tmpDir }));

const { getPxpipeStats } = await import("../../src/lib/pxpipe/events.js");

const eventsFile = path.join(tmpDir, "events.jsonl");
const originalTz = process.env.TZ;

// 22:30 local on a day where local and UTC dates disagree for TZ=Europe/Berlin.
function lateLocalToday() {
  const d = new Date();
  d.setHours(23, 30, 0, 0);
  return d.getTime();
}

beforeEach(() => {
  process.env.TZ = "Europe/Berlin";
  fs.rmSync(eventsFile, { force: true });
});

afterEach(() => {
  process.env.TZ = originalTz;
  fs.rmSync(eventsFile, { force: true });
});

describe("getPxpipeStats timeline bucketing", () => {
  it("counts a late-evening local event instead of dropping it", () => {
    const ts = lateLocalToday();
    fs.writeFileSync(
      eventsFile,
      JSON.stringify({ ts, applied: true, tokensSavedEst: 4242 }) + "\n",
    );

    const { timeline } = getPxpipeStats();
    const totalSaved = timeline.reduce((sum, day) => sum + day.tokensSavedEst, 0);
    const totalRequests = timeline.reduce((sum, day) => sum + day.requests, 0);

    expect(totalRequests).toBe(1);
    expect(totalSaved).toBe(4242);
  });

  it("uses local calendar dates as timeline keys", () => {
    fs.writeFileSync(eventsFile, JSON.stringify({ ts: lateLocalToday(), applied: false }) + "\n");
    const { timeline } = getPxpipeStats({ timelineDays: 3 });

    const d = new Date();
    const localToday = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    expect(timeline).toHaveLength(3);
    expect(timeline.at(-1).date).toBe(localToday);
    expect(timeline.at(-1).requests).toBe(1);
  });
});
