import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ proxyAwareFetch: vi.fn() }));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.proxyAwareFetch,
}));

const { getCodexUsage } = await import("../../open-sse/services/usage/codex.js");

describe("getCodexUsage auth failures", () => {
  beforeEach(() => mocks.proxyAwareFetch.mockReset());

  it.each([401, 403])("reports %i as an expired token, not an outage", async (status) => {
    mocks.proxyAwareFetch.mockResolvedValue({ ok: false, status });
    const usage = await getCodexUsage("token");
    expect(usage.message).toMatch(/expired/i);
    expect(usage.message).not.toMatch(/temporarily unavailable/i);
  });

  it("still reports other failures as temporarily unavailable", async () => {
    mocks.proxyAwareFetch.mockResolvedValue({ ok: false, status: 503 });
    const usage = await getCodexUsage("token");
    expect(usage.message).toMatch(/temporarily unavailable \(503\)/);
  });
});
