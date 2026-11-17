import { describe, expect, it, vi } from "vitest";

// The non-chat handlers share allLockedError: one of them, end to end.
const mocks = vi.hoisted(() => ({ handleEmbeddingsCore: vi.fn(), credentials: [] }));

vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: async () => mocks.credentials.shift() ?? null,
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: true })),
  clearAccountError: vi.fn(),
  extractApiKey: () => "client-key",
  isValidApiKey: vi.fn(),
}));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({ requireApiKey: false }) }));
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: async () => ({ provider: "openai", model: "text-embedding-3-small" }),
}));
vi.mock("../../open-sse/handlers/embeddingsCore.js", () => ({ handleEmbeddingsCore: mocks.handleEmbeddingsCore }));
vi.mock("../../open-sse/utils/error.js", () => ({
  errorResponse: (status, message) => Response.json({ error: message }, { status }),
  unavailableResponse: (status, message) => Response.json({ error: message }, { status }),
}));
vi.mock("../../src/sse/utils/logger.js", () => ({
  request: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), maskKey: vi.fn(),
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: vi.fn(),
  checkAndRefreshToken: async (_provider, credentials) => credentials,
}));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn() }));

const { handleEmbeddings } = await import("../../src/sse/handlers/embeddings.js");

describe("embeddings, every key locked after the dead key's 403", () => {
  it("sends the soonest key's 429 and its message", async () => {
    mocks.credentials = [
      { apiKey: "stub", connectionId: "dead", connectionName: "dead" },
      { allRateLimited: true, retryAfter: new Date(Date.now() + 2_000).toISOString(), retryAfterHuman: "reset after 2s", lastError: "rate_limit_error", lastErrorCode: 429 },
    ];
    mocks.handleEmbeddingsCore.mockResolvedValue({ success: false, status: 403, error: "Key barred from this endpoint" });

    const res = await handleEmbeddings(new Request("http://localhost/v1/embeddings", {
      method: "POST",
      body: JSON.stringify({ model: "openai/text-embedding-3-small", input: "hello" }),
    }));

    expect(res.status).toBe(429);
    expect((await res.json()).error).toContain("rate_limit_error");
  });
});
