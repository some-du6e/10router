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
});
