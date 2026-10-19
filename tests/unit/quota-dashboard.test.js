import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAccount,
  compareAccounts,
  compareBarAccounts,
  providerWindows,
  quotaRemaining,
  resetLabel,
  resetShort,
  summarizeWindow,
  updatedLabel,
} from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/dashboardModel.js";
import { fetchAllConnections } from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/useQuotaDashboard.js";
import { parseQuotaData } from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

function account(id, session, weekly, options = {}) {
  return buildAccount(
    { id, name: id, provider: "codex", ...options },
    {
      quotas: [
        {
          name: "5h",
          quotaType: "session",
          remaining: session,
          resetAt: "2026-10-07T01:00:00Z",
        },
        {
          name: "Weekly",
          quotaType: "weekly",
          remaining: weekly,
          resetAt: "2026-10-09T00:00:00Z",
        },
      ],
    },
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("quota dashboard", () => {
  it("shows 43 usable, preserving the blocked 72 in its segment", () => {
    const accounts = [
      account("primary", 43, 17),
      account("empty", 0, 0),
      account("sandbox", 72, 0),
    ];
    const summary = summarizeWindow(accounts, accounts[0].priority);
    expect(summary.total).toBe(43);
    expect(summary.values[2].quota.remaining).toBe(72);
    expect(summary.values[2].blocked).toBe("Weekly exhausted");
    expect(summary.capacity).toBe(300);
    expect(Math.round(summary.average)).toBe(14);
  });

  it("averages remaining quota instead of adding it past 100%", () => {
    const accounts = [account("a", 90, 90), account("b", 70, 80)];
    const summary = summarizeWindow(accounts, accounts[0].priority);
    expect(summary.average).toBe(80);
    expect(summary.averaged).toBe(true);
    expect(summarizeWindow([accounts[0]], accounts[0].priority).averaged).toBe(
      false,
    );
  });

  it("shows no average when every reporting account is turned off", () => {
    const off = account("off", 80, 80, { isActive: false });
    const summary = summarizeWindow([off], off.priority);
    expect(summary.average).toBeNull();
    expect(summary.total).toBeNull();
    expect(summary.stale).toBe(0);
  });

  it("counts a weekly-blocked account as empty even when its session is unknown", () => {
    const full = account("full", 80, 80);
    const blocked = account("blocked", null, 0);
    const summary = summarizeWindow([full, blocked], full.priority);
    expect(summary.average).toBe(40);
    expect(summary.unknown).toBe(0);
  });

  it("sorts by the same window that drives status, unknown last both ways", () => {
    const healthy = account("healthy", 50, 90);
    const low = account("low", 64, 23);
    const unknown = account("unknown", null, null);
    const ids = (sort) =>
      [unknown, healthy, low]
        .sort((a, b) => compareAccounts(a, b, sort))
        .map((a) => a.id);
    expect(ids("remaining")).toEqual(["low", "healthy", "unknown"]);
    expect(ids("remaining-desc")).toEqual(["healthy", "low", "unknown"]);
  });

  it("does not mark a per-model provider Depleted for one empty model", () => {
    const multi = buildAccount(
      { id: "ag", provider: "antigravity" },
      {
        quotas: [
          { name: "Gemini", remainingPercentage: 90 },
          { name: "Claude", remainingPercentage: 0 },
        ],
      },
    );
    expect(multi.status).not.toBe("Depleted");
  });

  it("uses singular units in the updated label", () => {
    const now = Date.parse("2026-10-07T02:00:00Z");
    expect(updatedLabel(now - 60000, now)).toBe("Updated 1 minute ago");
    expect(updatedLabel(now - 90 * 60000, now)).toBe("Updated 1 hour ago");
    expect(updatedLabel(now - 5 * 60000, now)).toBe("Updated 5 minutes ago");
  });

  it("takes status from the tightest window", () => {
    const low = account("low", 64, 23);
    expect(low.priority.kind).toBe("session");
    expect(low.status).toBe("Low quota");
  });

  it("keeps turned-off accounts visible but excludes them from totals and capacity", () => {
    const active = account("active", 43, 17);
    const off = account("off", 100, 100, { isActive: false });
    const summary = summarizeWindow([active, off], active.priority);
    expect(summary.values).toHaveLength(2);
    expect(summary.total).toBe(43);
    expect(summary.capacity).toBe(100);
    expect(off.status).toBe("Turned off");
  });

  it("prioritizes weekly only when it is exhausted", () => {
    expect(account("normal", 82, 1).priority.kind).toBe("session");
    const blocked = account("blocked", 72, 0);
    expect(blocked.mainWindows.map((q) => q.kind)).toEqual([
      "weekly",
      "session",
    ]);
    expect(blocked.status).toBe("Depleted");
  });

  it("sorts each bar in the same account order, with weekly-blocked and disabled last", () => {
    const accounts = [
      account("blocked", 99, 0),
      account("off", 100, 100, { isActive: false }),
      account("low", 20, 90),
      account("full", 90, 10),
    ].sort(compareBarAccounts);
    expect(accounts.map((a) => a.id)).toEqual([
      "full",
      "low",
      "blocked",
      "off",
    ]);
    for (const window of providerWindows(accounts)) {
      expect(
        summarizeWindow(accounts, window).values.map((v) => v.account.id),
      ).toEqual(accounts.map((a) => a.id));
    }
  });

  it("uses the blocking reset when sorting accounts", () => {
    const blocked = account("blocked", 90, 0);
    const usable = account("usable", 20, 20);
    expect(
      [blocked, usable]
        .sort((a, b) => compareAccounts(a, b, "reset"))
        .map((a) => a.id),
    ).toEqual(["usable", "blocked"]);
  });

  it("puts weekly first in the summary when every enabled account is weekly-blocked", () => {
    expect(
      providerWindows([
        account("blocked", 72, 0),
        account("off", 90, 90, { isActive: false }),
      ])[0].kind,
    ).toBe("weekly");
  });

  it("does not turn missing data or a zero denominator into full quota", () => {
    expect(quotaRemaining({ used: 0, total: 0 })).toBeNull();
    expect(quotaRemaining({ remainingPercentage: NaN })).toBeNull();
    expect(quotaRemaining({ used: 25, total: 100 })).toBe(75);
    expect(quotaRemaining({ remaining: 0 })).toBe(0);
    expect(quotaRemaining({ unlimited: true })).toBe(100);
    expect(quotaRemaining({ remaining: 110 })).toBe(100);
  });

  it("labels an entirely unreported total as unknown", () => {
    const unknown = account("unknown", null, null);
    expect(unknown.status).toBe("Unknown");
    expect(summarizeWindow([unknown], unknown.priority).total).toBeNull();
  });

  it("does not count a session as usable when its reported weekly quota is unknown", () => {
    const unknown = account("unknown", 75, null);
    expect(summarizeWindow([unknown], unknown.priority).total).toBe(0);
    expect(summarizeWindow([unknown], unknown.priority).values[0].blocked).toBe(
      "Weekly quota unknown",
    );
  });

  it("keeps the last reading with its original timestamp on refresh failure", () => {
    const stale = buildAccount(
      { id: "stale", provider: "codex" },
      {
        quotas: [{ name: "5h", remaining: 43 }],
        updatedAt: "2026-10-07T00:00:00Z",
      },
      "HTTP 429",
    );
    expect(stale.priority.remaining).toBe(43);
    expect(stale.updatedAt).toBe("2026-10-07T00:00:00Z");
    expect(stale.error).toBe("HTTP 429");
    expect(summarizeWindow([stale], stale.priority).stale).toBe(1);
  });

  it("does not mistake a model-specific weekly or Spark limit for the whole account limit", () => {
    const claude = buildAccount(
      { id: "claude", provider: "claude" },
      {
        quotas: parseQuotaData("claude", {
          quotas: {
            "session (5h)": { used: 10, total: 100 },
            "weekly (7d)": { used: 20, total: 100 },
            "weekly sonnet (7d)": { used: 100, total: 100 },
          },
        }),
      },
    );
    expect(claude.status).toBe("Healthy");
    expect(claude.mainWindows).toHaveLength(2);
    expect(claude.windows).toHaveLength(3);
    const codex = buildAccount(
      { id: "codex", provider: "codex" },
      {
        quotas: parseQuotaData("codex", {
          quotas: {
            session: { remaining: 80 },
            weekly: { remaining: 40 },
            spark_weekly: { remaining: 0 },
          },
        }),
      },
    );
    expect(codex.weeklyBlocked).toBe(false);
    expect(codex.mainWindows).toHaveLength(2);
  });

  it("keeps Codex free-plan monthly quota separate from paid 5-hour quota", () => {
    const free = buildAccount(
      { id: "free", provider: "codex" },
      {
        quotas: parseQuotaData("codex", {
          plan: "free",
          quotas: { session: { remaining: 60 } },
        }),
      },
    );
    expect(free.priority.kind).toBe("monthly");
    expect(
      providerWindows([free, account("paid", 40, 50)]).map((q) => q.kind),
    ).toEqual(["session", "weekly", "monthly"]);
  });

  it("distinguishes expired bonus credits from recurring resets", () => {
    const now = Date.parse("2026-10-07T00:00:00Z");
    expect(resetLabel({ resetAt: "invalid" }, now)).toBe("Reset not reported");
    expect(resetLabel({ resetAt: now - 1000 }, now)).toBe("Reset due");
    expect(resetLabel({ resetAt: now - 1000, recurring: false }, now)).toBe(
      "Expired",
    );
    expect(resetLabel({ resetAt: now + 3600000, recurring: false }, now)).toBe(
      "Expires in 1h",
    );
    expect(resetShort({ resetAt: now + 45 * 60000 }, now)).toBe("45m");
    expect(resetShort({ resetAt: now + 26 * 3600000 }, now)).toBe("1d 2h");
    expect(resetShort({}, now)).toBeNull();
  });
});

describe("account metadata pagination", () => {
  it("loads every page and deduplicates before displaying global totals", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          connections: [{ id: "one" }],
          pagination: { totalPages: 2 },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          connections: [{ id: "one" }, { id: "two" }],
          pagination: { totalPages: 2 },
        }),
      );
    vi.stubGlobal("fetch", fetch);
    expect(await fetchAllConnections(new AbortController().signal)).toEqual([
      { id: "one" },
      { id: "two" },
    ]);
    expect(fetch.mock.calls[1][0]).toContain("page=2");
  });

  it("rejects partial metadata rather than publishing incomplete totals", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            connections: [{ id: "one" }],
            pagination: { totalPages: 2 },
          }),
        )
        .mockResolvedValueOnce(Response.json({}, { status: 500 })),
    );
    await expect(
      fetchAllConnections(new AbortController().signal),
    ).rejects.toThrow("Could not load accounts");
  });
});
