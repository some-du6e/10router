// The Go gateway's memory gate (gateway/internal/admission) reads Node's
// MEMORY_ADMISSION defaults and answers a refusal with Node's own 503. Both
// come from here: tables.json is the export the Go port embeds, and
// testdata/busy.json is busyResponse for a Claude client, which the Go tests
// must reproduce byte for byte.
//
// Without ADMISSION_RECORD this checks the committed files are still what
// Node makes. With ADMISSION_RECORD=1 it writes them.
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Node's defaults, not whatever this shell sets.
for (const name of ["INFLIGHT_BODY_BUDGET_MB", "INFLIGHT_QUEUE_WAIT_MS", "INFLIGHT_RETRY_AFTER_S", "INFLIGHT_UNKNOWN_BODY_MB"]) delete process.env[name];

const { MEMORY_ADMISSION, MAX_TIMER_MS } = await import("../../open-sse/config/runtimeConfig.js");
const { busyResponse } = await import("../../src/sse/services/memoryAdmission.js");
const { CLAUDE_RETRYABLE_STREAM_ERROR_TYPE } = await import("../../open-sse/config/errorConfig.js");

const DIR = fileURLToPath(new URL("../../gateway/internal/admission/", import.meta.url));
const RECORD = process.env.ADMISSION_RECORD === "1";
const MB = 1024 * 1024;
const MARK = 987654;

async function busy(retryAfterSec) {
  const response = busyResponse("claude", retryAfterSec);
  return { retryAfterSec, status: response.status, headers: Object.fromEntries(response.headers.entries()), body: await response.text() };
}

async function tablesText() {
  const { body } = await busy(MARK);
  const message = JSON.parse(body).error.message;
  expect(message).toContain(String(MARK));
  return JSON.stringify({
    budgetMb: MEMORY_ADMISSION.budgetBytes / MB,
    bodyCopies: MEMORY_ADMISSION.bodyCopies,
    maxWaitMs: MEMORY_ADMISSION.maxWaitMs,
    retryAfterSec: MEMORY_ADMISSION.retryAfterSec,
    unknownBodyMb: MEMORY_ADMISSION.unknownBodyBytes / MB,
    recheckMs: MEMORY_ADMISSION.recheckMs,
    highWaterFraction: MEMORY_ADMISSION.highWaterFraction,
    maxTimerMs: MAX_TIMER_MS,
    busyMessage: message.replace(String(MARK), "{s}"),
    busyErrorType: CLAUDE_RETRYABLE_STREAM_ERROR_TYPE,
  }, null, 2) + "\n";
}

describe("memory gate export for the Go gateway", () => {
  it("keeps the table export the Go port embeds", async () => {
    const text = await tablesText();
    if (RECORD) writeFileSync(`${DIR}tables.json`, text);
    expect(readFileSync(`${DIR}tables.json`, "utf8"), "regenerate with ADMISSION_RECORD=1").toBe(text);
  });

  it("keeps Node's 503 for a Claude client", async () => {
    const text = JSON.stringify(await Promise.all([1, 10, 3600].map(busy)), null, 1) + "\n";
    if (RECORD) writeFileSync(`${DIR}testdata/busy.json`, text);
    expect(readFileSync(`${DIR}testdata/busy.json`, "utf8"), "regenerate with ADMISSION_RECORD=1").toBe(text);
  });
});
