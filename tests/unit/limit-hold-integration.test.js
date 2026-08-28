import { describe, it, expect, vi, beforeEach } from "vitest";
import { LIMIT_HOLD_SENTINEL } from "open-sse/utils/limitHold.js";

// Exercises the real account loop in src/sse/handlers/chat.js with the
// provider/credential layer stubbed, so the hold wiring itself is under test.
const state = {
  settings: { limitHoldEnabled: true, limitHoldOnPinned: false, requireApiKey: false },
  keyHold: null,
  credentials: null,
  coreResults: [],
  markCalls: [],
};

vi.mock("@/lib/localDb", () => ({ getSettings: async () => state.settings }));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyLimitHold: async () => state.keyHold }));
vi.mock("@/sse/services/auth.js", async () => {
  const actual = await vi.importActual("@/sse/services/auth.js");
  return {
    ...actual,
    extractApiKey: () => "sk-test",
    isValidApiKey: async () => true,
    getProviderCredentials: async () => state.credentials,
    markAccountUnavailable: async (...args) => { state.markCalls.push(args); return { shouldFallback: true, cooldownMs: 1000 }; },
    clearAccountError: async () => {},
  };
});
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: async (m) => ({ provider: "codex", model: m }),
  getComboModels: async () => null,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_p, c) => c,
  updateProviderCredentials: async () => {},
}));
vi.mock("open-sse/handlers/chatCore.js", async (importOriginal) => ({
  // Keep the real clientReceivesStream — the streaming decision is under test.
  ...(await importOriginal()),
  handleChatCore: async () => state.coreResults.shift(),
}));

const { handleChat } = await import("@/sse/handlers/chat.js");

function makeRequest(body, extraHeaders = {}) {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer sk-test", ...extraHeaders },
    body: JSON.stringify(body),
  });
}

const LIMITED = () => ({
  allRateLimited: true,
  retryAfter: new Date(Date.now() + 7_200_000).toISOString(),
  retryAfterHuman: "reset after 2h",
  lastError: "usage_limit_reached",
  lastErrorCode: 429,
});

beforeEach(() => {
  vi.restoreAllMocks(); // the rotation test spies on getProviderCredentials
  state.settings = { limitHoldEnabled: true, limitHoldOnPinned: false, requireApiKey: false };
  state.keyHold = null;
  state.markCalls = [];
  state.coreResults = [];
});

describe("rate-limit hold wiring", () => {
  it("holds the stream open instead of returning 429 when all accounts are limited", async () => {
    state.credentials = {
      allRateLimited: true,
      retryAfter: new Date(Date.now() + 7_200_000).toISOString(),
      retryAfterHuman: "reset after 2h",
      lastError: "usage_limit_reached",
      lastErrorCode: 429,
    };

    const res = await handleChat(makeRequest({ model: "gpt-5", stream: true, messages: [{ role: "user", content: "hi" }] }));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    const reader = res.body.getReader();
    const { value } = await reader.read();
    const first = new TextDecoder().decode(value);
    expect(first).toContain("codex limit reached");
    expect(first).toContain("2h");
    expect(first).toContain(LIMIT_HOLD_SENTINEL);
    await reader.cancel();
  });

  it("still returns the error when hold is disabled globally", async () => {
    state.settings.limitHoldEnabled = false;
    state.credentials = {
      allRateLimited: true,
      retryAfter: new Date(Date.now() + 7_200_000).toISOString(),
      retryAfterHuman: "reset after 2h",
      lastError: "usage_limit_reached",
      lastErrorCode: 429,
    };

    const res = await handleChat(makeRequest({ model: "gpt-5", stream: true, messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: { message: expect.stringContaining("usage_limit_reached") } });
  });

  it("a fail-fast key overrides the global hold", async () => {
    state.keyHold = false;
    state.credentials = {
      allRateLimited: true,
      retryAfter: new Date(Date.now() + 7_200_000).toISOString(),
      retryAfterHuman: "reset after 2h",
      lastError: "usage_limit_reached",
      lastErrorCode: 429,
    };

    const res = await handleChat(makeRequest({ model: "gpt-5", stream: true, messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(429);
  });

  it("does not hold on a non-limit failure", async () => {
    state.credentials = {
      allRateLimited: true,
      retryAfter: new Date(Date.now() + 60_000).toISOString(),
      retryAfterHuman: "reset after 1m",
      lastError: "invalid api key",
      lastErrorCode: 401,
    };

    const res = await handleChat(makeRequest({ model: "gpt-5", stream: true, messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(401);
  });

  it("passes a successful response straight through", async () => {
    state.credentials = { connectionId: "c1", connectionName: "acct", accessToken: "t" };
    state.coreResults = [{ success: true, response: new Response("ok") }];

    const res = await handleChat(makeRequest({ model: "gpt-5", stream: true, messages: [{ role: "user", content: "hi" }] }));
    expect(await res.text()).toBe("ok");
  });

  it("rotates accounts before considering a hold", async () => {
    let call = 0;
    state.credentials = { connectionId: "c1", connectionName: "acct1", accessToken: "t" };
    state.coreResults = [
      { success: false, status: 429, error: "usage_limit_reached" },
      { success: true, response: new Response("second account ok") },
    ];
    const auth = await import("@/sse/services/auth.js");
    vi.spyOn(auth, "getProviderCredentials").mockImplementation(async () => {
      call += 1;
      return { connectionId: `c${call}`, connectionName: `acct${call}`, accessToken: "t" };
    });

    const res = await handleChat(makeRequest({ model: "gpt-5", stream: true, messages: [{ role: "user", content: "hi" }] }));
    expect(await res.text()).toBe("second account ok");
    expect(state.markCalls.length).toBe(1); // first account got locked, then we moved on
  });

  it("never hands SSE to a client that asked for JSON via Accept", async () => {
    // AI SDK style: Accept: application/json, no explicit stream flag. This used
    // to get a clean JSON error; it must not now receive an SSE banner it can't parse.
    state.credentials = { connectionId: "c1", connectionName: "acct", accessToken: "t" };
    // First pass hits the limit; the hold's first re-attempt succeeds. A short
    // minWait makes the hold's sleep tick so the test finishes fast.
    state.coreResults = [
      { success: false, status: 429, error: "usage_limit_reached", retryAtMs: Date.now() + 10 },
      { success: true, response: new Response('{"ok":true}', { headers: { "Content-Type": "application/json" } }) },
    ];

    const res = await handleChat(
      makeRequest({ model: "gpt-5", messages: [{ role: "user", content: "hi" }] }),
      { endpoint: "/v1/chat/completions", body: {}, headers: { accept: "application/json" } }
    );

    expect(res.headers.get("Content-Type")).not.toBe("text/event-stream");
    expect(await res.text()).toBe('{"ok":true}');
  }, 30000);
});
