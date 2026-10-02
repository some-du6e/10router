import { describe, expect, it } from "vitest";
import { readUsageHubResponse } from "../../src/shared/utils/usageHubResponse.js";

const fallback = "Could not save hub settings";

describe("hub settings response validation", () => {
  it.each(["<html>Unavailable</html>", ""])("uses the fallback for non-JSON error responses", async (body) => {
    await expect(readUsageHubResponse(new Response(body, { status: 502 }), fallback)).rejects.toThrow(fallback);
  });

  it("preserves server-provided error messages", async () => {
    await expect(readUsageHubResponse(Response.json({ error: "Session expired" }, { status: 401 }), fallback))
      .rejects.toThrow("Session expired");
  });

  it.each([null, [], {}, { enabled: "true" }, { error: "oops" }])("rejects malformed successful settings: %j", async (data) => {
    await expect(readUsageHubResponse(Response.json(data), fallback)).rejects.toThrow(fallback);
  });

  it("rejects a non-JSON success rather than replacing the current config", async () => {
    await expect(readUsageHubResponse(new Response("<html>Login</html>"), fallback)).rejects.toThrow(fallback);
  });

  it.each([true, false])("accepts a valid enabled=%s response and preserves its one-time key", async (enabled) => {
    const config = { enabled, keyConfigured: true, managementKey: "hub_new-key" };
    expect(await readUsageHubResponse(Response.json(config), fallback)).toEqual(config);
  });
});
