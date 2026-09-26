import { describe, it, expect, vi, beforeEach } from "vitest";

const { proxyAwareFetch } = vi.hoisted(() => ({
  proxyAwareFetch: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));

const { getClaudeUsage } = await import("../../open-sse/services/usage/claude.js");

function response(status, body = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe("Claude usage subscription status", () => {
  beforeEach(() => {
    proxyAwareFetch.mockReset();
    vi.useRealTimers();
  });

  it("reports an inactive subscription when the OAuth usage endpoint rejects access", async () => {
    proxyAwareFetch.mockResolvedValueOnce(response(403));

    const result = await getClaudeUsage("claude-status-inactive", null, { force: true });

    expect(result.status).toBe("subscription_inactive");
    expect(result.message).toContain("subscription is inactive");
    expect(result.message).not.toContain("Claude connected");
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it("keeps legacy permission failures as unavailable", async () => {
    proxyAwareFetch.mockResolvedValueOnce(response(500));
    proxyAwareFetch.mockResolvedValueOnce(response(403));

    const result = await getClaudeUsage("claude-status-unavailable", null, { force: true });

    expect(result.status).toBe("unavailable");
    expect(result.message).toContain("usage is unavailable");
    expect(result.message).not.toContain("Claude connected");
  });

  it("does not let expired quota data hide a later inactive status", async () => {
    vi.useFakeTimers();
    proxyAwareFetch.mockResolvedValueOnce(
      response(200, { five_hour: { utilization: 10 } }),
    );

    const first = await getClaudeUsage("claude-status-expired", null, { force: true });
    expect(first.quotas["session (5h)"].remaining).toBe(90);

    vi.advanceTimersByTime(300001);
    proxyAwareFetch.mockResolvedValueOnce(response(403));

    const inactive = await getClaudeUsage("claude-status-expired");
    expect(inactive.status).toBe("subscription_inactive");

    const cachedInactive = await getClaudeUsage("claude-status-expired");
    expect(cachedInactive.status).toBe("subscription_inactive");
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
  });
});
