/**
 * Regression for the Claude usage cache soft-failure path.
 *
 * Before the fix, a soft failure ({ message: ... }, no `quotas`) left the
 * settled { promise } entry in `usageCache`. Every later non-forced request
 * returned that same failed promise and never retried, so quota stayed broken
 * until the TTL (which only applied to successful entries) — i.e. forever.
 *
 * After the fix, a soft failure either restores the last good result (expired,
 * so the next call re-fetches) or clears the slot, so a subsequent call
 * retries. This test mocks `proxyAwareFetch` to fail once then succeed and
 * confirms the second non-forced call re-fetches.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const proxyAwareFetch = vi.fn();

vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));

// shared.js re-exports registry constants; leave the real module in place so
// the provider registry loads. The usage URLs it resolves don't matter —
// proxyAwareFetch is mocked, so nothing reaches the network.
vi.mock("open-sse/providers/shared.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ANTHROPIC_API_VERSION: "2023-06-01" };
});

const { getClaudeUsage } = await import("../../open-sse/services/usage/claude.js");

function softFailure() {
  // A non-429 OAuth error so fetchClaudeUsageRaw falls to the legacy path.
  // Legacy makes a settings fetch; returning ok:false there yields a soft
  // { message } result (no `quotas`). Two mocks total for one soft failure.
  return {
    ok: false,
    status: 500,
    headers: { get: () => null },
    json: async () => ({ message: "server error" }),
    text: async () => "server error",
  };
}

function successQuota() {
  // fetchClaudeUsageRaw builds `quotas` from data.five_hour.utilization /
  // data.seven_day.utilization. Provide a minimal valid envelope so
  // result.quotas is a non-empty object.
  return {
    ok: true,
    status: 200,
    headers: { get: (h) => (h === "content-type" ? "application/json" : null) },
    json: async () => ({ five_hour: { utilization: 12, resets_at: null } }),
    text: async () => JSON.stringify({ five_hour: { utilization: 12 } }),
  };
}

describe("getClaudeUsage cache — soft failure retries", () => {
  beforeEach(() => {
    proxyAwareFetch.mockReset();
  });

  it("retries after a soft failure instead of returning the stuck failed promise", async () => {
    // First call: soft failure (OAuth 500 → legacy settings 500 ⇒ { message }).
    // Second call: success. The cache must not pin the failed result so the
    // second non-forced call re-fetches.
    proxyAwareFetch
      .mockResolvedValueOnce(softFailure()) // primary OAuth 500
      .mockResolvedValueOnce(softFailure()) // legacy settings 500
      .mockResolvedValueOnce(successQuota()); // retry: primary OAuth 200

    const first = await getClaudeUsage("token-A", null);
    // Soft failure with no prior good read returns the failure envelope.
    expect(first?.quotas).toBeUndefined();

    // Second, non-forced call must re-fetch (not return the stuck failed promise).
    const second = await getClaudeUsage("token-A", null);
    expect(second?.quotas).toBeDefined();
    expect(proxyAwareFetch).toHaveBeenCalledTimes(3);
  });

  it("serves a fresh successful result from cache on the next non-forced call", async () => {
    proxyAwareFetch.mockResolvedValueOnce(successQuota());

    await getClaudeUsage("token-B", null);
    await getClaudeUsage("token-B", null); // should hit cache, no extra fetch

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
  });
});
