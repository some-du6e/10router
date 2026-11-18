import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A refresh result's providerSpecificData holds only what the refresh changed
// (Kiro external_idp returns four fields, no profileArn or region). The retry
// right after it must still see the request's other fields.

const mocks = vi.hoisted(() => ({
  executorRefresh: vi.fn(), execute: vi.fn(), refreshByProvider: vi.fn(),
  connections: vi.fn(), persist: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ refreshCredentials: mocks.executorRefresh }),
}));
vi.mock("../../open-sse/services/tokenRefresh.js", async (importOriginal) => ({
  ...(await importOriginal()),
  refreshTokenByProvider: mocks.refreshByProvider,
}));
vi.mock("../../open-sse/handlers/imageProviders/index.js", () => ({
  getImageAdapter: () => ({
    buildUrl: (_model, creds) => `https://images.example.test/${creds.providerSpecificData?.region}`,
    buildBody: async () => ({ prompt: "hello" }),
    buildHeaders: (creds) => ({ Authorization: `Bearer ${creds.accessToken}`, "X-Account": creds.providerSpecificData?.accountId }),
    normalize: (parsed) => parsed,
  }),
}));
vi.mock("../../open-sse/handlers/embeddingProviders/index.js", () => ({
  getEmbeddingAdapter: () => ({
    buildUrl: (_model, creds) => `https://embeddings.example.test/${creds.providerSpecificData?.region}`,
    buildHeaders: (creds) => ({ Authorization: `Bearer ${creds.accessToken}`, "X-Account": creds.providerSpecificData?.accountId }),
    buildBody: (model, data) => ({ model, ...data }),
    normalize: (body) => body,
  }),
}));
// translator/send's own imports
vi.mock("open-sse/index.js", () => ({ getExecutor: () => ({ execute: mocks.execute, refreshCredentials: mocks.executorRefresh }) }));
vi.mock("../../src/lib/localDb.js", () => ({ getProviderConnections: mocks.connections }));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({ updateProviderCredentials: mocks.persist }));

import { handleImageGenerationCore } from "../../open-sse/handlers/imageGenerationCore.js";
import { handleEmbeddingsCore } from "../../open-sse/handlers/embeddingsCore.js";
import { handleVideoProxyCore } from "../../open-sse/handlers/videoCore.js";
import { POST as translatorSend } from "../../src/app/api/translator/send/route.js";

const originalFetch = global.fetch;
const kiroPatch = { authMethod: "external_idp", clientId: "client-id", tokenEndpoint: "https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token", scope: "offline_access" };
const refreshed = { accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 3600, providerSpecificData: kiroPatch };
const stored = () => ({
  accessToken: "old-access", refreshToken: "old-refresh",
  providerSpecificData: { ...kiroPatch, accountId: "acct", profileArn: "profile-1", region: "eu-west-1" },
});
const expectedData = { ...kiroPatch, accountId: "acct", profileArn: "profile-1", region: "eu-west-1" };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.executorRefresh.mockResolvedValue(refreshed);
  mocks.refreshByProvider.mockResolvedValue(refreshed);
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("retry after a patch-only refresh keeps the request's other credential fields", () => {
  it("image generation", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(json({ error: "expired" }, 401)).mockResolvedValueOnce(json({ created: 1, data: [] }));
    const onCredentialsRefreshed = vi.fn();
    const result = await handleImageGenerationCore({
      body: { prompt: "hello" }, modelInfo: { provider: "test-provider", model: "m" }, credentials: stored(), onCredentialsRefreshed,
    });
    expect(result.success).toBe(true);
    const [url, init] = global.fetch.mock.calls[1];
    expect(url).toBe("https://images.example.test/eu-west-1");
    expect(init.headers).toMatchObject({ Authorization: "Bearer new-access", "X-Account": "acct" });
    expect(onCredentialsRefreshed).toHaveBeenCalledWith(refreshed);
  });

  it("embeddings", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(json({ error: "expired" }, 401)).mockResolvedValueOnce(json({ object: "list", data: [], usage: {} }));
    const credentials = stored();
    const result = await handleEmbeddingsCore({
      body: { input: "hello" }, modelInfo: { provider: "test-provider", model: "m" }, credentials,
    });
    expect(result.success).toBe(true);
    const [url, init] = global.fetch.mock.calls[1];
    expect(url).toBe("https://embeddings.example.test/eu-west-1");
    expect(init.headers).toMatchObject({ Authorization: "Bearer new-access", "X-Account": "acct" });
    expect(credentials.providerSpecificData).toEqual(expectedData);
  });

  it("video", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(json({ error: "expired" }, 401)).mockResolvedValueOnce(json({ request_id: "job" }));
    const credentials = stored();
    const result = await handleVideoProxyCore({
      provider: "xai", action: "generations", rawBody: "{}", contentType: "application/json", credentials,
    });
    expect(result.success).toBe(true);
    expect(global.fetch.mock.calls[1][1].headers.Authorization).toBe("Bearer new-access");
    expect(credentials.providerSpecificData).toEqual(expectedData);
  });

  it("translator send, which also saves the result through updateProviderCredentials", async () => {
    mocks.connections.mockResolvedValue([{ id: "conn-1", isActive: true, ...stored() }]);
    const seen = [];
    mocks.execute.mockImplementation(async ({ credentials }) => {
      seen.push(structuredClone(credentials));
      return { response: seen.length === 1 ? json({ error: "expired" }, 401) : new Response("data: ok\n\n") };
    });
    const response = await translatorSend(new Request("http://localhost/api/translator/send", {
      method: "POST", body: JSON.stringify({ provider: "kiro", model: "m", body: { stream: true } }),
    }));
    expect(response.status).toBe(200);
    expect(seen[1]).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh", providerSpecificData: expectedData });
    expect(mocks.persist).toHaveBeenCalledWith("conn-1", refreshed);
  });
});
