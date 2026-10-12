import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const dbRoot = process.env.DB_AUDIT_ROOT || path.resolve(import.meta.dirname, "../../src/lib/db");
const stateKeys = ["_pendingRequests", "_pendingTimers", "_statsEmitTimers", "_lastErrorProvider", "_statsEmitter"];
let track;

beforeEach(async () => {
  vi.useFakeTimers();
  for (const key of stateKeys) delete global[key];
  vi.resetModules();
  track = (await import(`${dbRoot}/repos/usageRepo.js`)).trackPendingRequest;
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  for (const key of stateKeys) delete global[key];
});

it("keeps the timeout for an overlapping request after its peer finishes", () => {
  track("model", "provider", "account", true);
  track("model", "provider", "account", true);
  track("model", "provider", "account", false);
  expect(global._pendingRequests.byModel["model (provider)"]).toBe(1);
  vi.advanceTimersByTime(60000);
  expect(global._pendingRequests.byModel["model (provider)"] || 0).toBe(0);
  expect(global._pendingRequests.byAccount.account).toBeUndefined();
});

it("expires one account without erasing another account's active model count", () => {
  track("model", "provider", "first", true);
  vi.advanceTimersByTime(10000);
  track("model", "provider", "second", true);
  vi.advanceTimersByTime(50000);
  expect(global._pendingRequests.byModel["model (provider)"]).toBe(1);
  expect(global._pendingRequests.byAccount.second["model (provider)"]).toBe(1);
  // A late completion for an expired bucket cannot decrement another account.
  track("model", "provider", "first", false);
  expect(global._pendingRequests.byModel["model (provider)"]).toBe(1);
  track("model", "provider", "second", false);
  expect(global._pendingRequests.byModel).toEqual({});
});

it("keeps keyless and account timeouts independent", () => {
  track("model", "provider", null, true);
  vi.advanceTimersByTime(10000);
  track("model", "provider", "account", true);
  vi.advanceTimersByTime(50000);
  expect(global._pendingRequests.byModel["model (provider)"]).toBe(1);
  track("model", "provider", "account", false);
  expect(global._pendingRequests.byModel).toEqual({});
});
