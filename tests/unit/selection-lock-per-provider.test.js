import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(async () => {}),
  getSettings: vi.fn(async () => ({})),
  getProxyPools: vi.fn(async () => []),
  validateApiKey: vi.fn(),
}));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/lib/network/connectionProxy", () => ({
  pickProxyPoolId: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => (provider === "kc" ? "kilocode" : provider),
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const { getProviderCredentials } = await import("../../src/sse/services/auth.js");

// Each getProviderConnections call blocks until released, so the test controls
// how long a pick holds the lock and can count how many picks are inside it.
let inside;
let maxInside;
let gates;

function release(provider) {
  gates.get(provider).shift()();
}

beforeEach(() => {
  vi.clearAllMocks();
  inside = new Map();
  maxInside = new Map();
  gates = new Map();
  dbMocks.getProviderConnections.mockImplementation(({ provider }) => {
    const n = (inside.get(provider) || 0) + 1;
    inside.set(provider, n);
    maxInside.set(provider, Math.max(maxInside.get(provider) || 0, n));
    return new Promise((resolve) => {
      if (!gates.has(provider)) gates.set(provider, []);
      gates.get(provider).push(() => {
        inside.set(provider, inside.get(provider) - 1);
        resolve([{ id: `${provider}-a`, provider, isActive: true }]);
      });
    });
  });
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("account selection lock", () => {
  it("serializes picks for the same provider", async () => {
    const picks = [getProviderCredentials("openai"), getProviderCredentials("openai"), getProviderCredentials("openai")];
    await flush();
    expect(gates.get("openai")).toHaveLength(1);
    for (let i = 0; i < 3; i++) {
      release("openai");
      await flush();
    }
    const results = await Promise.all(picks);
    expect(results.every((r) => r.connectionId === "openai-a")).toBe(true);
    expect(maxInside.get("openai")).toBe(1);
  });

  it("does not make other providers wait on a slow pick", async () => {
    const slow = getProviderCredentials("anthropic");
    await flush();
    const fast = getProviderCredentials("openai");
    await flush();
    // anthropic is still holding its lock; openai must already be inside its own
    expect(gates.get("openai")).toHaveLength(1);
    release("openai");
    await expect(fast).resolves.toMatchObject({ connectionId: "openai-a" });
    release("anthropic");
    await expect(slow).resolves.toMatchObject({ connectionId: "anthropic-a" });
  });

  it("keeps working after a pick throws", async () => {
    dbMocks.getProviderConnections.mockRejectedValueOnce(new Error("db down"));
    await expect(getProviderCredentials("openai")).rejects.toThrow("db down");
    dbMocks.getProviderConnections.mockResolvedValueOnce([{ id: "openai-b", provider: "openai", isActive: true }]);
    await expect(getProviderCredentials("openai")).resolves.toMatchObject({ connectionId: "openai-b" });
  });

  it("makes an alias share its provider's lock", async () => {
    const viaAlias = getProviderCredentials("kc");
    const direct = getProviderCredentials("kilocode");
    await flush();
    expect(gates.get("kilocode")).toHaveLength(1);
    release("kilocode");
    await flush();
    release("kilocode");
    await Promise.all([viaAlias, direct]);
    expect(maxInside.get("kilocode")).toBe(1);
  });

  it("keeps a late caller queued behind picks that are still waiting", async () => {
    const first = getProviderCredentials("openai");
    const second = getProviderCredentials("openai");
    await flush();
    release("openai");
    await first;
    // second now holds the lock; a caller arriving now must wait for it
    const third = getProviderCredentials("openai");
    await flush();
    expect(gates.get("openai")).toHaveLength(1);
    release("openai");
    await second;
    await flush();
    release("openai");
    await third;
    expect(maxInside.get("openai")).toBe(1);
  });

  it("releases a caller queued behind a pick that throws", async () => {
    let fail;
    dbMocks.getProviderConnections.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
    const failing = getProviderCredentials("openai");
    const queued = getProviderCredentials("openai");
    await flush();
    fail(new Error("db down"));
    await expect(failing).rejects.toThrow("db down");
    await flush();
    release("openai");
    await expect(queued).resolves.toMatchObject({ connectionId: "openai-a" });
  });
});

describe("account selection lock bookkeeping", () => {
  it("keeps the lock map on global and empties it once picks settle", async () => {
    const map = global._selectionMutexes;
    expect(map).toBeInstanceOf(Map);
    const a = getProviderCredentials("openai");
    const b = getProviderCredentials("openai");
    await flush();
    expect(map.has("openai")).toBe(true);
    release("openai");
    await a;
    await flush();
    release("openai");
    await b;
    expect(map.has("openai")).toBe(false);
  });

  it("drops the entry after a pick throws", async () => {
    dbMocks.getProviderConnections.mockRejectedValueOnce(new Error("db down"));
    await expect(getProviderCredentials("anthropic")).rejects.toThrow("db down");
    expect(global._selectionMutexes.has("anthropic")).toBe(false);
  });

  it("shares the lock with a second module instance", async () => {
    vi.resetModules();
    const other = await import("../../src/sse/services/auth.js");
    const first = getProviderCredentials("openai");
    const second = other.getProviderCredentials("openai");
    await flush();
    expect(gates.get("openai")).toHaveLength(1);
    release("openai");
    await first;
    await flush();
    release("openai");
    await second;
    expect(maxInside.get("openai")).toBe(1);
  });
});
