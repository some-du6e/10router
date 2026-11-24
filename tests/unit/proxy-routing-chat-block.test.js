// A chat request for an account whose proxy is blocked is refused before any
// executor runs, so even an executor that doesn't send through proxyAwareFetch
// (Devin CLI's subprocess) never sends it.
import { describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...a) => fetchMock(...a) }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn(async () => new Proxy({}, {
    get: (target, key) => (key === "then" ? undefined : (target[key] ??= vi.fn())),
  })),
}));
vi.mock("../../open-sse/translator/concerns/prefetch.js", () => ({ prefetchRemoteImages: vi.fn(async () => 0) }));
const { appendRequestLog } = vi.hoisted(() => ({ appendRequestLog: vi.fn(async () => {}) }));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog, saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

const PROVIDER = "openai-compatible-proxy-block-test";
const MODEL = "test-model";

describe("handleChatCore with a blocked proxy", () => {
  it("fails with the block reason and sends nothing upstream", async () => {
    const body = { model: `${PROVIDER}/${MODEL}`, stream: false, messages: [{ role: "user", content: "hi" }] };
    const result = await handleChatCore({
      body,
      modelInfo: { provider: PROVIDER, model: MODEL },
      credentials: {
        apiKey: "sk-test",
        connectionId: "acct-a",
        providerSpecificData: { baseUrl: "https://gateway.example.test/v1", blockedReason: 'Proxy pool "Old office VPN" is turned off', strictProxy: true },
      },
      clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: {} },
      connectionId: "acct-a",
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(String(result.error)).toContain("Old office VPN");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(appendRequestLog).toHaveBeenCalledWith(expect.objectContaining({ status: "FAILED 502" }));
  });
});
