// Add endpoint dialog: the failure copy matches the mockup's wording, counting
// from the server's own step list when the live list lags a tick behind.
import { describe, it, expect } from "vitest";
import { failCopy } from "@/app/(dashboard)/dashboard/providers/components/AddEndpointParts.tsx";

const net = (n) => ({ n, state: "done", kind: "network", hint: "no answer in 8s", text: "x", note: "", startedAt: 0 });

describe("failCopy", () => {
  it("says how many requests went unanswered", () => {
    const c = failCopy({ failure: "unreachable", steps: [net(1), net(2)], url: "http://llm.corp-example.net:8443/v1" });
    expect(c.kind).toBe("unreachable");
    expect(c.title).toBe("Couldn't reach llm.corp-example.net:8443");
    expect(c.body).toMatch(/^Two requests, no answer in 8s each, so we stopped/);
  });

  it("uses the server's count when the live list is one step short", () => {
    const c = failCopy({ failure: "unreachable", steps: [net(1)], netCount: 2, url: "http://10.0.0.9:8443/v1" });
    expect(c.body).toMatch(/^Two requests,/);
  });

  it("revoked key: every request came back 401", () => {
    const c = failCopy({ failure: undefined, steps: [], url: "http://x", revoked: { checked: 18 } });
    expect(c.title).toBe("Your key stopped working");
    expect(c.icon).toBe("key_off");
    expect(c.body).toContain("It worked for the first 18 checks, then every request came back 401.");
  });
});

describe("failCopy, key refused on the first model check", () => {
  it("doesn't say 'the first 0 checks'", () => {
    const c = failCopy({ steps: [], url: "http://x", revoked: { checked: 0 } });
    expect(c.body).not.toMatch(/first 0/);
    expect(c.body).toMatch(/^It passed the first requests, then every model check came back 401\./);
  });
});
