import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ credentials: vi.fn(), markUnavailable: vi.fn(), clearError: vi.fn(), settings: vi.fn(), validKey: vi.fn(), modelInfo: vi.fn(), core: vi.fn(), saveUsage: vi.fn() }));
vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.credentials,
  markAccountUnavailable: mocks.markUnavailable,
  clearAccountError: mocks.clearError,
  extractApiKey: (request) => request.headers.get("authorization")?.replace(/^Bearer /, ""),
  isValidApiKey: mocks.validKey,
}));
vi.mock("../../src/lib/db/index.js", () => ({ getSettings: mocks.settings }));
vi.mock("../../src/sse/services/model.js", () => ({ getModelInfo: mocks.modelInfo }));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({ checkAndRefreshToken: async (_, credentials) => credentials }));
vi.mock("../../open-sse/handlers/systemoneCore.js", () => ({ handleSystemoneCore: mocks.core }));
vi.mock("../../src/lib/usageDb.js", () => ({ saveRequestUsage: mocks.saveUsage }));

import { handleSystemone } from "../../src/sse/handlers/systemone.js";

const payload = { model: "oc/jev-1.13-free", state: "Payment failed", questions: { urgent: { type: "noul" } } };
const request = (body = payload, headers = {}) => new Request("http://localhost:20128/v1/systemone", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const failure = () => ({ success: false, status: 429, error: "Quota exceeded", response: Response.json({ error: "Quota exceeded" }, { status: 429 }) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.settings.mockResolvedValue({ requireApiKey: false });
  mocks.modelInfo.mockResolvedValue({ provider: "opencode", model: "jev-1.13-free" });
  mocks.markUnavailable.mockResolvedValue({ shouldFallback: true });
  mocks.saveUsage.mockResolvedValue(undefined);
});

describe("System One app handler", () => {
  it("enforces gateway API-key settings", async () => {
    mocks.settings.mockResolvedValue({ requireApiKey: true });
    expect((await handleSystemone(request())).status).toBe(401);
    mocks.validKey.mockResolvedValue(false);
    expect((await handleSystemone(request(payload, { authorization: "Bearer invalid" }))).status).toBe(401);
    expect(mocks.core).not.toHaveBeenCalled();
  });

  it("rejects null bodies and non-string models", async () => {
    expect((await handleSystemone(request(null))).status).toBe(400);
    expect((await handleSystemone(request({ ...payload, model: 123 }))).status).toBe(400);
    expect(mocks.core).not.toHaveBeenCalled();
  });

  it("falls back across accounts and records successful usage", async () => {
    mocks.credentials.mockResolvedValueOnce({ connectionId: "first" }).mockResolvedValueOnce({ connectionId: "second" });
    mocks.core.mockResolvedValueOnce(failure()).mockImplementationOnce(async ({ onRequestSuccess }) => {
      await onRequestSuccess();
      return { success: true, usage: { prompt_tokens: 12, completion_tokens: 3 }, response: Response.json({ answers: { urgent: { noul: 0.9 } } }) };
    });
    const response = await handleSystemone(request(payload, { authorization: "Bearer gateway-key", "x-connection-id": "first" }));
    expect(response.status).toBe(200);
    expect(mocks.credentials.mock.calls[1][1]).toEqual(new Set(["first"]));
    expect(mocks.credentials.mock.calls[0][3]).toEqual({ preferredConnectionId: "first" });
    expect(mocks.clearError).toHaveBeenCalledWith("second", expect.any(Object), "jev-1.13-free");
    expect(mocks.saveUsage).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "gateway-key", connectionId: "second", tokens: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }));
  });

  it("stops after a failed virtual free account instead of retrying forever", async () => {
    mocks.credentials.mockResolvedValue({ id: "noauth", accessToken: "public" });
    mocks.core.mockResolvedValue(failure());
    expect((await handleSystemone(request())).status).toBe(429);
    expect(mocks.core).toHaveBeenCalledOnce();
  });
});
