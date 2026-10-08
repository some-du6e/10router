import { describe, expect, it } from "vitest";
import { summarizeAccountFailures, formatAccountLimitMessage, getNextAccountReset } from "../../src/sse/services/accountFailureSummary.js";

describe("summarizeAccountFailures", () => {
  it("shows the limiting reason for every attempted account", () => {
    const weekly = JSON.stringify({
      type: "error",
      error: { type: "GoUsageLimitError", message: "Weekly usage limit reached. Resets in 22 hours." },
    });
    const monthly = `[opencode-go/glm-5.2] [429]: ${JSON.stringify({
      type: "error",
      error: { type: "GoUsageLimitError", message: "Monthly usage limit reached. Resets in 2 days." },
    })}`;

    const summary = summarizeAccountFailures("opencode-go", "glm-5.2", [
      { account: "Primary", status: 429, error: weekly },
      { account: "Backup", status: 429, error: monthly },
    ]);

    expect(summary).toBe(
      "All 2 accounts unavailable for [opencode-go/glm-5.2]. " +
      "Primary (HTTP 429): Weekly usage limit reached. Resets in 22 hours. | " +
      "Backup (HTTP 429): Monthly usage limit reached. Resets in 2 days."
    );
  });

  it("preserves plain-text provider errors", () => {
    expect(summarizeAccountFailures("demo", "model", [
      { account: "Only account", status: 503, error: "Upstream unavailable" },
    ])).toContain("Only account (HTTP 503): Upstream unavailable");
  });
});

describe("account limit messages", () => {
  it("shows the next provider reset rather than a retry cooldown", () => {
    expect(formatAccountLimitMessage(Date.now() + 2 * 3600000)).toBe(
      "All your accounts have hit their limits. Next account resets in 2 hours."
    );
  });

  it("does not invent a reset time when none is known", () => {
    expect(formatAccountLimitMessage()).toBe("All your accounts have hit their limits.");
    expect(formatAccountLimitMessage("reset after 16s")).toBe("All your accounts have hit their limits.");
  });

  it("selects the earliest real reset, ignoring shorter router locks", () => {
    const reset = Date.now() + 2 * 3600000;
    expect(getNextAccountReset([
      { modelLock_demo: new Date(Date.now() + 16000).toISOString(), providerReset_demo: new Date(reset).toISOString() },
      { providerReset_demo: new Date(reset + 3600000).toISOString() },
    ], "demo")).toBe(reset);
  });

  it("omits the countdown if an account's real reset is unknown", () => {
    expect(getNextAccountReset([{ providerReset_demo: new Date(Date.now() + 7200000).toISOString() }, {}], "demo")).toBeNull();
  });
});
