import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("open-sse/index.js", () => ({}), { virtual: true });
vi.mock("@/lib/db/index.js", () => ({
  getNotificationChannels: vi.fn(),
  getProviderConnections: vi.fn(),
  getQuotaNotificationState: vi.fn(),
  setQuotaNotificationState: vi.fn(),
}));
vi.mock("open-sse/services/usage.js", () => ({ getUsageForProvider: vi.fn() }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn() }));
vi.mock("@/app/api/usage/[connectionId]/route.js", () => ({ refreshAndUpdateCredentials: vi.fn() }));
vi.mock("@/shared/constants/providers", () => ({
  USAGE_SUPPORTED_PROVIDERS: ["codex"],
  USAGE_APIKEY_PROVIDERS: [],
}));
vi.mock("@/lib/notifications/constants.js", async () => {
  const actual = await vi.importActual("../../src/lib/notifications/constants.js");
  return { ...actual, NOTIFICATION_CONFIG: { ...actual.NOTIFICATION_CONFIG, tickIntervalMs: 60_000, claudePollIntervalMs: 180_000 } };
});
vi.mock("@/lib/notifications/index.js", () => ({ dispatchNotificationEvent: vi.fn() }));

import {
  hasQuotaNotificationSubscribers,
  runQuotaNotificationTick,
} from "../../src/shared/services/quotaNotifications.js";

describe("quota notification scheduler", () => {
  let deps;
  let state;

  beforeEach(() => {
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    deps = {
      getNotificationChannels: vi.fn().mockResolvedValue([{ id: "channel", isActive: true, events: ["quota_exhausted"] }]),
      getProviderConnections: vi.fn().mockResolvedValue([{ id: "codex-1", provider: "codex", authType: "oauth", isActive: true, accessToken: "token", name: "Main" }]),
      getQuotaNotificationState: vi.fn().mockResolvedValue({ quotas: { weekly: { exhausted: false } } }),
      setQuotaNotificationState: vi.fn(),
      getUsageForProvider: vi.fn().mockResolvedValue({ quotas: { weekly: { used: 100, total: 100, resetAt: "2026-01-02T00:00:00Z" } } }),
      resolveConnectionProxyConfig: vi.fn().mockResolvedValue({}),
      refreshAndUpdateCredentials: vi.fn(async (connection) => ({ connection, refreshed: false })),
      dispatchNotificationEvent: vi.fn().mockResolvedValue({ sent: 1, failures: [] }),
    };
    state = { running: false, lastPolledAt: {} };
  });

  it("stays idle without a subscribed active channel", async () => {
    deps.getNotificationChannels.mockResolvedValue([{ id: "channel", isActive: true, events: [] }]);
    await runQuotaNotificationTick(deps, state);
    expect(deps.getProviderConnections).not.toHaveBeenCalled();
  });

  it("recognizes only active quota-event subscribers", () => {
    expect(hasQuotaNotificationSubscribers([
      { isActive: false, events: ["quota_exhausted"] },
      { isActive: true, events: ["test"] },
    ])).toBe(false);
    expect(hasQuotaNotificationSubscribers([
      { isActive: true, events: ["quota_reset"] },
    ])).toBe(true);
  });

  it("persists quota state before dispatching an exhaustion event", async () => {
    await runQuotaNotificationTick(deps, state);

    expect(deps.setQuotaNotificationState).toHaveBeenCalledWith("codex-1", expect.objectContaining({
      quotas: { weekly: expect.objectContaining({ exhausted: true }) },
    }));
    expect(deps.dispatchNotificationEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "quota_exhausted",
      provider: "codex",
      connectionId: "codex-1",
      connectionName: "Main",
      quotaName: "weekly",
    }));
    expect(deps.setQuotaNotificationState.mock.invocationCallOrder[0]).toBeLessThan(deps.dispatchNotificationEvent.mock.invocationCallOrder[0]);
  });

  it("does not repoll a connection inside its interval", async () => {
    await runQuotaNotificationTick(deps, state);
    await runQuotaNotificationTick(deps, state);
    expect(deps.getUsageForProvider).toHaveBeenCalledTimes(1);
  });
});
