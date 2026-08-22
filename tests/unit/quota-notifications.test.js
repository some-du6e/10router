import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}), { virtual: true });
vi.mock("@/lib/db/index.js", () => ({
  getNotificationChannelById: vi.fn(),
  getNotificationChannels: vi.fn(),
}));

import { detectQuotaTransitions, getQuotaRemainingPercentage } from "../../src/lib/notifications/quotaTransitions.js";
import { dispatchNotificationEvent, sendNotificationChannel } from "../../src/lib/notifications/index.js";
import { createPinnedLookup, notificationFetch } from "../../src/lib/notifications/http.js";
import { NOTIFICATION_EVENTS } from "../../src/lib/notifications/constants.js";
import { normalizeNotificationChannelInput, redactNotificationChannel } from "../../src/lib/notifications/validation.js";

describe("quota notification transitions", () => {
  it("does not alert on the first quota observation", () => {
    const result = detectQuotaTransitions(null, {
      quotas: { weekly: { used: 100, total: 100, resetAt: "2026-01-02T00:00:00Z" } },
    });

    expect(result.events).toEqual([]);
    expect(result.state.quotas.weekly.exhausted).toBe(true);
  });

  it("detects exhaustion and a later reset exactly once", () => {
    const available = detectQuotaTransitions(null, {
      quotas: { weekly: { used: 50, total: 100, resetAt: "2026-01-02T00:00:00Z" } },
    });
    const exhausted = detectQuotaTransitions(available.state, {
      quotas: { weekly: { used: 100, total: 100, resetAt: "2026-01-02T00:00:00Z" } },
    });
    const stillExhausted = detectQuotaTransitions(exhausted.state, {
      quotas: { weekly: { used: 100, total: 100, resetAt: "2026-01-02T00:00:00Z" } },
    });
    const reset = detectQuotaTransitions(stillExhausted.state, {
      quotas: { weekly: { used: 0, total: 100, resetAt: "2026-01-09T00:00:00Z" } },
    });

    expect(exhausted.events).toEqual([expect.objectContaining({ type: NOTIFICATION_EVENTS.QUOTA_EXHAUSTED, quotaName: "weekly" })]);
    expect(stillExhausted.events).toEqual([]);
    expect(reset.events).toEqual([expect.objectContaining({ type: NOTIFICATION_EVENTS.QUOTA_RESET, quotaName: "weekly" })]);
  });

  it("normalizes the quota shapes used by providers", () => {
    expect(getQuotaRemainingPercentage({ remainingPercentage: 25 })).toBe(25);
    expect(getQuotaRemainingPercentage({ remaining: 25, total: 100 })).toBe(25);
    expect(getQuotaRemainingPercentage({ used: 75, total: 100 })).toBe(25);
    expect(getQuotaRemainingPercentage({ unlimited: true, used: 100, total: 100 })).toBeNull();
  });
});

describe("notification channels", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps stored secrets when an edit leaves the secret input blank", () => {
    const input = normalizeNotificationChannelInput({
      name: "Slack ops",
      type: "slack",
      events: [NOTIFICATION_EVENTS.QUOTA_RESET],
      config: { webhookUrl: "" },
    }, {
      name: "Slack ops",
      type: "slack",
      isActive: true,
      events: [NOTIFICATION_EVENTS.QUOTA_EXHAUSTED],
      config: { webhookUrl: "https://hooks.slack.com/services/secret" },
    });

    expect(input.config.webhookUrl).toBe("https://hooks.slack.com/services/secret");
    expect(redactNotificationChannel(input)).toMatchObject({
      config: {},
      configuredSecrets: { webhookUrl: true },
    });
  });

  it("redacts generic webhook headers and preserves them when left blank", () => {
    const input = normalizeNotificationChannelInput({
      name: "Deploy webhook",
      type: "webhook",
      events: [NOTIFICATION_EVENTS.QUOTA_EXHAUSTED],
      config: { url: "https://example.com/hook", headers: {} },
    }, {
      name: "Deploy webhook",
      type: "webhook",
      isActive: true,
      events: [NOTIFICATION_EVENTS.QUOTA_RESET],
      config: {
        url: "https://example.com/hook",
        headers: { "X-Webhook-Secret": "secret-value" },
      },
    });

    expect(input.config.headers).toEqual({ "X-Webhook-Secret": "secret-value" });
    expect(redactNotificationChannel(input)).toMatchObject({
      config: { url: "https://example.com/hook" },
      configuredSecrets: { headers: true },
    });
  });

  it("sends a Slack payload without following redirects", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: vi.fn() });
    await sendNotificationChannel({
      id: "slack-1",
      name: "Slack",
      type: "slack",
      config: { webhookUrl: "https://hooks.slack.com/services/test" },
    }, {
      type: NOTIFICATION_EVENTS.QUOTA_EXHAUSTED,
      provider: "codex",
      connectionName: "Main",
      quotaName: "weekly",
      remainingPercentage: 0,
    }, {
      fetch: fetchMock,
      assertDestination: vi.fn(),
    });

    expect(fetchMock).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({
      method: "POST",
      redirect: "manual",
      body: expect.stringContaining("codex Quota exhausted"),
    }));
  });

  it("pins the validated destination address for the outbound request", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const dispatcher = { close };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const assertDestination = vi.fn().mockResolvedValue([{ address: "203.0.113.10", family: 4 }]);
    const createDispatcher = vi.fn().mockReturnValue(dispatcher);

    await notificationFetch("https://example.com/hook", {}, {
      fetch: fetchMock,
      assertDestination,
      createDispatcher,
    });

    expect(createDispatcher).toHaveBeenCalledWith({ address: "203.0.113.10", family: 4 });
    expect(fetchMock).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ dispatcher }));
    expect(close).toHaveBeenCalled();
  });

  it("returns the pinned address in the format requested by Undici", async () => {
    const address = { address: "203.0.113.10", family: 4 };
    const lookup = createPinnedLookup(address);

    await expect(new Promise((resolve, reject) => {
      lookup("example.com", { all: true }, (error, result) => error ? reject(error) : resolve(result));
    })).resolves.toEqual([address]);
    await expect(new Promise((resolve, reject) => {
      lookup("example.com", { all: false }, (error, result, family) => (
        error ? reject(error) : resolve({ result, family })
      ));
    })).resolves.toEqual({ result: address.address, family: address.family });
  });

  it("bounds error response reads and cancels the remaining stream", async () => {
    const first = new Uint8Array(600).fill(97);
    const read = vi.fn().mockResolvedValueOnce({ done: false, value: first });
    const cancel = vi.fn().mockResolvedValue(undefined);
    const releaseLock = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      body: { getReader: () => ({ read, cancel, releaseLock }) },
    });

    await expect(notificationFetch("https://example.com/hook", {}, {
      fetch: fetchMock,
      assertDestination: vi.fn().mockResolvedValue(null),
    })).rejects.toThrow(`Notification request failed (500): ${"a".repeat(500)}`);

    expect(read).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalled();
  });

  it("isolates failures between channels", async () => {
    const channels = [
      { id: "ok", name: "OK", type: "webhook", isActive: true, events: [NOTIFICATION_EVENTS.QUOTA_RESET], config: { url: "https://example.com/ok", method: "POST" } },
      { id: "bad", name: "Bad", type: "webhook", isActive: true, events: [NOTIFICATION_EVENTS.QUOTA_RESET], config: { url: "https://example.com/bad", method: "POST" } },
    ];
    const fetchMock = vi.fn(async (url) => ({
      ok: !url.pathname.endsWith("/bad"),
      status: url.pathname.endsWith("/bad") ? 500 : 200,
      body: url.pathname.endsWith("/bad")
        ? new Response("failed").body
        : null,
    }));

    const result = await dispatchNotificationEvent({ type: NOTIFICATION_EVENTS.QUOTA_RESET }, {
      getNotificationChannels: vi.fn().mockResolvedValue(channels),
      fetch: fetchMock,
      assertDestination: vi.fn(),
    });

    expect(result).toMatchObject({ attempted: 2, sent: 1 });
    expect(result.failures).toEqual([expect.objectContaining({ channelId: "bad" })]);
  });
});
