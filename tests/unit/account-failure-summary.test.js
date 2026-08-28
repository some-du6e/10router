import { describe, expect, it } from "vitest";
import { summarizeAccountFailures } from "../../src/sse/services/accountFailureSummary.js";

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
