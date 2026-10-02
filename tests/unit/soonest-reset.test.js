import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claude: vi.fn(), codex: vi.fn(), proxy: vi.fn(), connections: vi.fn(), settings: vi.fn(),
}));
vi.mock("open-sse/services/usage/claude.js", () => ({ getClaudeUsage: mocks.claude }));
vi.mock("open-sse/services/usage/codex.js", () => ({ getCodexUsage: mocks.codex }));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.proxy, pickProxyPoolId: vi.fn(),
}));
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.connections, getSettings: mocks.settings,
  getProxyPools: vi.fn(), validateApiKey: vi.fn(), updateProviderConnection: vi.fn(),
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const NOW = Date.parse("2026-10-02T00:00:00Z");
const hours = (h) => new Date(NOW + h * 3_600_000).toISOString();
const quota = (h, used = 25) => ({ used, total: 100, remaining: 100 - used, resetAt: hours(h) });
let routing;

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mocks.proxy.mockResolvedValue({ connectionProxyEnabled: true, connectionProxyUrl: "http://proxy:8080" });
  mocks.settings.mockResolvedValue({ fallbackStrategy: "soonest-reset" });
  routing = await import("@/sse/services/soonestReset.js");
});
afterEach(() => vi.useRealTimers());

describe("soonest reset ranking", () => {
  const pick = (quotas, provider = "codex", model = "gpt-6") => {
    const connections = quotas.map((_, i) => ({ id: String(i) }));
    const states = new Map(connections.map((c, i) => [c.id, routing.getResetState(provider, quotas[i], model)]));
    return routing.pickSoonestReset(connections, states).id;
  };

  it("spends the earliest weekly allowance before accounts with earlier session resets", () => {
    expect(pick([
      { weekly: quota(72), session: quota(1) },
      { weekly: quota(24), session: quota(4) },
    ])).toBe("1");
  });

  it("uses session resets to break ties and supports session-only accounts", () => {
    expect(pick([{ weekly: quota(24), session: quota(4) }, { weekly: quota(24), session: quota(1) }])).toBe("1");
    expect(pick([{ session: quota(4) }, { session: quota(1) }])).toBe("1");
    expect(pick([{}, {}])).toBe("0");
    expect(pick([{ weekly: quota(24) }, { weekly: quota(24) }])).toBe("0");
  });

  it("ignores missing, invalid, past, and unlimited reset data", () => {
    expect(pick([{}, { weekly: { resetAt: "bad" } }, { weekly: quota(-1) }, { weekly: { ...quota(1), unlimited: true } }, { weekly: quota(24) }])).toBe("4");
  });

  it("uses only the requested model's Claude weekly bucket", () => {
    const quotas = { "weekly (7d)": quota(72), "weekly opus (7d)": quota(1, 100), "weekly sonnet (7d)": quota(24) };
    expect(routing.getResetState("claude", quotas, "claude-sonnet-4-6")).toMatchObject({ blockedUntil: 0, weeklyReset: Date.parse(hours(24)) });
    expect(routing.getResetState("claude", quotas, "claude-opus-4-6").blockedUntil).toBe(Date.parse(hours(1)));
  });

  it("isolates Spark and ignores Codex code-review quotas", () => {
    const quotas = { weekly: quota(72), spark_weekly: quota(24, 100), review_weekly: quota(1, 100) };
    expect(routing.getResetState("codex", quotas, "gpt-6")).toMatchObject({ blockedUntil: 0, weeklyReset: Date.parse(hours(72)) });
    expect(routing.getResetState("codex", quotas, "gpt-5.3-codex-spark").blockedUntil).toBe(Date.parse(hours(24)));
  });

  it("waits until all exhausted windows reset, then stops blocking on past snapshots", () => {
    const quotas = { weekly: quota(24, 100), session: quota(2, 100) };
    expect(routing.getResetState("codex", quotas).blockedUntil).toBe(Date.parse(hours(24)));
    expect(routing.getResetState("codex", quotas, null, Date.parse(hours(25))).blockedUntil).toBe(0);
  });
});

describe("background quota reads", () => {
  const connections = [{ id: "a", accessToken: "token", providerSpecificData: {} }];

  it("returns immediately, deduplicates fetches, and respects the connection proxy", async () => {
    mocks.codex.mockResolvedValue({ quotas: { weekly: quota(24) } });
    expect(routing.getRoutingQuotas("codex", connections).size).toBe(0);
    routing.getRoutingQuotas("codex", connections);
    await vi.advanceTimersByTimeAsync(0);
    expect(routing.getRoutingQuotas("codex", connections).get("a")).toEqual({ weekly: quota(24) });
    expect(mocks.codex).toHaveBeenCalledTimes(1);
    expect(mocks.codex).toHaveBeenCalledWith("token", expect.objectContaining({ connectionProxyUrl: "http://proxy:8080" }));
  });

  it("expires stale data after failed refreshes and retries a hung fetch", async () => {
    mocks.codex.mockResolvedValueOnce({ quotas: { weekly: quota(24, 100) } }).mockImplementation(() => new Promise(() => {}));
    routing.getRoutingQuotas("codex", connections);
    await vi.advanceTimersByTimeAsync(60_000);
    routing.getRoutingQuotas("codex", connections);
    await vi.advanceTimersByTimeAsync(60_000);
    routing.getRoutingQuotas("codex", connections);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.codex).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(180_001);
    expect(routing.getRoutingQuotas("codex", connections).size).toBe(0);
  });

  it("does not fetch for unsupported providers or missing tokens", () => {
    routing.getRoutingQuotas("openai", connections);
    routing.getRoutingQuotas("claude", [{ id: "a" }]);
    expect(mocks.codex).not.toHaveBeenCalled();
    expect(mocks.claude).not.toHaveBeenCalled();
  });
});

describe("credential selection", () => {
  let getProviderCredentials;
  beforeEach(async () => {
    ({ getProviderCredentials } = await import("@/sse/services/auth.js"));
    mocks.connections.mockResolvedValue([
      { id: "a", accessToken: "a", priority: 1 },
      { id: "b", accessToken: "b", priority: 2 },
    ]);
    mocks.codex.mockImplementation(async (token) => ({ quotas: { weekly: quota(token === "a" ? 72 : 24) } }));
  });
  const warm = async () => {
    await getProviderCredentials("codex", null, "gpt-6");
    await vi.advanceTimersByTimeAsync(0);
  };

  it("falls back to priority while cold, then chooses the earliest reset", async () => {
    expect((await getProviderCredentials("codex", null, "gpt-6")).connectionId).toBe("a");
    await vi.advanceTimersByTimeAsync(0);
    expect((await getProviderCredentials("codex", null, "gpt-6")).connectionId).toBe("b");
  });

  it("preserves affinity and exclusions", async () => {
    await warm();
    expect((await getProviderCredentials("codex", null, "gpt-6", { preferredConnectionId: "a" })).connectionId).toBe("a");
    expect((await getProviderCredentials("codex", new Set(["b"]), "gpt-6")).connectionId).toBe("a");
  });

  it("skips an exhausted pinned account and reports the earliest usable reset when all are exhausted", async () => {
    mocks.codex.mockImplementation(async (token) => ({ quotas: { weekly: quota(token === "a" ? 72 : 24, token === "b" ? 100 : 25) } }));
    await warm();
    expect((await getProviderCredentials("codex", null, "gpt-6", { preferredConnectionId: "b" })).connectionId).toBe("a");
    mocks.codex.mockImplementation(async (token) => ({ quotas: { weekly: quota(token === "a" ? 72 : 24, 100) } }));
    await vi.advanceTimersByTimeAsync(60_000);
    await warm();
    expect(await getProviderCredentials("codex", null, "gpt-6")).toMatchObject({ allRateLimited: true, retryAfter: hours(24) });
  });

  it("respects provider overrides and does not fetch for fill-first", async () => {
    mocks.settings.mockResolvedValue({ fallbackStrategy: "soonest-reset", providerStrategies: { codex: { fallbackStrategy: "fill-first" } } });
    await warm();
    expect((await getProviderCredentials("codex")).connectionId).toBe("a");
    expect(mocks.codex).not.toHaveBeenCalled();
  });

  it("skips model-locked and incompatible accounts even when they reset first", async () => {
    await warm();
    mocks.connections.mockResolvedValue([
      { id: "a", accessToken: "a" },
      { id: "b", accessToken: "b", "modelLock_gpt-6": hours(1) },
    ]);
    expect((await getProviderCredentials("codex", null, "gpt-6")).connectionId).toBe("a");
    mocks.connections.mockResolvedValue([
      { id: "a", accessToken: "a" },
      { id: "b", accessToken: "b", plan: "free" },
    ]);
    expect((await getProviderCredentials("codex", null, "gpt-6")).connectionId).toBe("a");
  });

  it("does not advertise a retry before an account's quota and cooldown both clear", async () => {
    mocks.codex.mockResolvedValue({ quotas: { weekly: quota(24, 100) } });
    mocks.connections.mockResolvedValue([{ id: "a", accessToken: "a", "modelLock_gpt-6": hours(1) }]);
    await warm();
    expect(await getProviderCredentials("codex", null, "gpt-6")).toMatchObject({ retryAfter: hours(24) });
  });
});
