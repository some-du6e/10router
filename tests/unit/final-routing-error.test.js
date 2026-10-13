import { describe, expect, it } from "vitest";
import { finalizeRoutingError } from "../../src/sse/services/finalRoutingError.js";

const exhausted = { clientTool: "codex", routingFailures: [{ limited: true }] };

describe("final Codex limit errors", () => {
  it("returns a readable terminal error with upstream retry metadata", async () => {
    const response = finalizeRoutingError(new Response("quota exhausted", {
      status: 429, headers: { "retry-after": "30", "content-length": "15", "access-control-allow-origin": "*" },
    }), exhausted);
    expect(response.status).toBe(400);
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(response.headers.get("x-10router-upstream-status")).toBe("429");
    expect(response.headers.get("x-10router-retry-after")).toBe("30");
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(response.headers.has("retry-after")).toBe(false);
    expect(response.headers.has("content-length")).toBe(false);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.text()).toBe("All your accounts have hit their limits.");
  });

  it.each([null, "claude", "github-copilot"])("leaves %s clients untouched", (clientTool) => {
    const response = new Response("limited", { status: 429 });
    expect(finalizeRoutingError(response, { ...exhausted, clientTool })).toBe(response);
    expect(response.bodyUsed).toBe(false);
  });

  it.each([408, 409, 429, 500, 503])("preserves unconfirmed or mixed %i failures", (status) => {
    for (const routingFailures of [[], [{ limited: false }], [{ limited: false }, { limited: true }]]) {
      const response = new Response("retry me", { status, headers: { "retry-after": "30" } });
      expect(finalizeRoutingError(response, { clientTool: "codex", routingFailures })).toBe(response);
      expect(response.bodyUsed).toBe(false);
    }
  });

  it("keeps successful streams unchanged", () => {
    const response = new Response("partial stream");
    expect(finalizeRoutingError(response, exhausted)).toBe(response);
    expect(response.bodyUsed).toBe(false);
  });

  it("uses the earliest known reset across fallback models", async () => {
    const response = finalizeRoutingError(new Response("limits", { status: 429 }), {
      clientTool: "codex", routingFailures: [
        { limited: true, resetAtMs: Date.now() + 3 * 3600000 },
        { limited: true, resetAtMs: Date.now() + 2 * 3600000 },
      ],
    });
    expect(await response.text()).toBe("All your accounts have hit their limits. Next account resets in 2 hours.");
  });
});
