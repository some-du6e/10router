// The account loop (src/sse/handlers/chat.ts) hands every attempt of one pass
// the same attemptCache, so an account after a 429 can resend what the last
// one was sent (see attempt-reuse.test.js); another request gets its own.
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = { coreResults: [], caches: [], call: 0, settings: null, credentials: null };

vi.mock("@/lib/localDb", () => ({ getSettings: async () => state.settings || { requireApiKey: false } }));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyLimitHold: async () => null, getApiKeyPolicy: async () => null }));
vi.mock("@/sse/services/auth.js", async () => {
  const actual = await vi.importActual("@/sse/services/auth.js");
  return {
    ...actual,
    extractApiKey: () => "sk-test",
    isValidApiKey: async () => true,
    getProviderCredentials: async () => {
      if (state.credentials) return state.credentials.shift();
      state.call += 1;
      return { connectionId: `c${state.call}`, connectionName: `acct${state.call}`, accessToken: "t" };
    },
    markAccountUnavailable: async () => ({ shouldFallback: true, cooldownMs: 1000 }),
    clearAccountError: async () => {},
  };
});
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: async (m) => ({ provider: "codex", model: m }),
  getComboModels: async () => null,
  comboLookupName: (name) => name,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_p, c) => c,
  updateProviderCredentials: async () => {},
}));
vi.mock("open-sse/handlers/chatCore.js", async (importOriginal) => ({
  ...(await importOriginal()),
  handleChatCore: async (args) => {
    state.caches.push(args.attemptCache);
    return state.coreResults.shift();
  },
}));

const { handleChat } = await import("@/sse/handlers/chat.js");

const request = ({ stream = false } = {}) => new Request("http://localhost/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer sk-test" },
  body: JSON.stringify({ model: "gpt-5", stream, messages: [{ role: "user", content: "hi" }] }),
});

beforeEach(() => {
  state.coreResults = [];
  state.caches = [];
  state.call = 0;
});

describe("the account loop's attempt cache", () => {
  it("is one object for every account a pass tries", async () => {
    state.coreResults = [
      { success: false, status: 429, error: "rate limited" },
      { success: false, status: 429, error: "rate limited" },
      { success: true, response: new Response("third account ok") },
    ];
    const res = await handleChat(request());
    expect(await res.text()).toBe("third account ok");
    expect(state.caches).toHaveLength(3);
    expect(state.caches[0]).toEqual(expect.any(Object));
    expect(state.caches[1]).toBe(state.caches[0]);
    expect(state.caches[2]).toBe(state.caches[0]);
  });

  it("is a new one for the pass a rate-limit hold runs after the first", async () => {
    const { DEFAULT_TIMING } = await import("open-sse/utils/limitHold.js");
    const timing = { ...DEFAULT_TIMING };
    Object.assign(DEFAULT_TIMING, { minWaitMs: 10, recheckMs: 10 });
    state.settings = { requireApiKey: false, limitHoldEnabled: true, limitHoldOnPinned: false };
    // Pass 1: one account, limited, then every account limited. Pass 2: an account that answers.
    state.credentials = [
      { connectionId: "c1", connectionName: "acct1", accessToken: "t" },
      { allRateLimited: true, allLimitsExhausted: true, retryAfter: new Date(Date.now() + 50).toISOString(), retryAfterHuman: "reset after 1s", lastError: "usage_limit_reached", lastErrorCode: 429 },
      { connectionId: "c2", connectionName: "acct2", accessToken: "t" },
    ];
    state.coreResults = [
      { success: false, status: 429, error: "usage_limit_reached" },
      { success: true, response: new Response("data: {}\n\n", { headers: { "Content-Type": "text/event-stream" } }) },
    ];
    try {
      const res = await handleChat(request({ stream: true }));
      await res.text();
    } finally {
      Object.assign(DEFAULT_TIMING, timing);
      state.settings = null;
      state.credentials = null;
    }
    expect(state.caches).toHaveLength(2);
    expect(state.caches[1]).toEqual(expect.any(Object));
    expect(state.caches[1]).not.toBe(state.caches[0]);
  }, 30_000);

  it("is a new one for another request", async () => {
    state.coreResults = [{ success: true, response: new Response("a") }, { success: true, response: new Response("b") }];
    await handleChat(request());
    await handleChat(request());
    expect(state.caches).toHaveLength(2);
    expect(state.caches[1]).not.toBe(state.caches[0]);
  });
});
