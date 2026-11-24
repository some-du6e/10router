// The connection test refreshes an expired Kiro IDC token itself: a stored
// region that isn't an AWS region must not pick the host the client secret
// and refresh token go to.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const state = vi.hoisted(() => ({ connection: null }));
vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: vi.fn(async () => state.connection),
  updateProviderConnection: vi.fn(async () => state.connection),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({ connectionProxyEnabled: false, connectionProxyUrl: "", vercelRelayUrl: "" })),
}));
vi.mock("@/lib/network/proxyTest", () => ({ testProxyUrl: vi.fn() }));

const { testSingleConnection } = await import("../../src/app/api/providers/[id]/test/testUtils.js");

const realFetch = globalThis.fetch;
let calls;
beforeEach(() => {
  calls = [];
  globalThis.fetch = vi.fn(async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ accessToken: "new", expiresIn: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
  });
});
afterEach(() => { globalThis.fetch = realFetch; });

const kiro = (region) => ({
  id: "k1",
  provider: "kiro",
  authType: "oauth",
  accessToken: "old",
  refreshToken: "rt",
  expiresAt: new Date(Date.now() - 60_000).toISOString(),
  providerSpecificData: { authMethod: "idc", clientId: "c", clientSecret: "s", region },
});

describe("Kiro connection test", () => {
  it("refreshes at us-east-1 when the stored region isn't an AWS region", async () => {
    state.connection = kiro("x.attacker.example/");
    await testSingleConnection("k1");
    expect(calls[0]).toBe("https://oidc.us-east-1.amazonaws.com/token");
    expect(calls.some((u) => u.includes("attacker"))).toBe(false);
  });

  it("keeps a real region", async () => {
    state.connection = kiro("eu-central-1");
    await testSingleConnection("k1");
    expect(calls[0]).toBe("https://oidc.eu-central-1.amazonaws.com/token");
  });
});
