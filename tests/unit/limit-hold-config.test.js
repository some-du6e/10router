import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory settings + api key store standing in for the DB layer.
const store = { settings: { limitHoldEnabled: true, limitHoldOnPinned: false }, keyHold: null };

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => store.settings,
}));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({
  getApiKeyLimitHold: async () => store.keyHold,
}));

const { resolveLimitHold } = await import("@/sse/services/limitHoldConfig.js");

describe("limit-hold config resolution", () => {
  beforeEach(() => { store.settings = { limitHoldEnabled: true, limitHoldOnPinned: false }; store.keyHold = null; });

  it("a keyless request follows the global setting", async () => {
    expect(await resolveLimitHold(null)).toEqual({ enabled: true, onPinned: false });
    store.settings.limitHoldEnabled = false;
    expect((await resolveLimitHold(null)).enabled).toBe(false);
  });

  it("a key with no override inherits the global", async () => {
    expect((await resolveLimitHold("sk-x")).enabled).toBe(true);
  });

  it("a CI key can fail fast while the global waits", async () => {
    store.keyHold = false;
    expect((await resolveLimitHold("sk-ci")).enabled).toBe(false);
  });

  it("a key can wait while the global fails fast", async () => {
    store.settings.limitHoldEnabled = false;
    store.keyHold = true;
    expect((await resolveLimitHold("sk-cli")).enabled).toBe(true);
  });

  it("surfaces the pinned-account option", async () => {
    store.settings.limitHoldOnPinned = true;
    expect((await resolveLimitHold(null)).onPinned).toBe(true);
  });
});
