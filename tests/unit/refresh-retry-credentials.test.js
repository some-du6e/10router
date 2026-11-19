import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A refresh result's providerSpecificData holds only what the refresh changed
// (Kiro external_idp returns four fields, no profileArn or region). The retry
// right after it must still see the request's other fields, and a failed save
// of the new tokens must not fail a request that can go on with them.

const mocks = vi.hoisted(() => ({
  executorRefresh: vi.fn(), execute: vi.fn(), refreshByProvider: vi.fn(), refreshKiro: vi.fn(),
  connections: vi.fn(), getById: vi.fn(), update: vi.fn(), kiroModels: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ execute: mocks.execute, refreshCredentials: mocks.executorRefresh, needsRefresh: () => true }),
}));
vi.mock("../../open-sse/services/tokenRefresh.js", async (importOriginal) => ({
  ...(await importOriginal()),
  refreshTokenByProvider: mocks.refreshByProvider,
  refreshKiroToken: mocks.refreshKiro,
}));
// chatCore's logging and usage side effects
// Every logger method is a no-op ("then" stays undefined so the logger isn't taken for a promise).
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn(async () => new Proxy({}, {
    get: (target, key) => (key === "then" ? undefined : (target[key] ??= vi.fn())),
  })),
}));
vi.mock("../../open-sse/translator/concerns/prefetch.js", () => ({ prefetchRemoteImages: vi.fn(async () => 0) }));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
  saveRequestUsage: vi.fn(() => Promise.resolve()),
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
vi.mock("../../open-sse/services/kiroModels.js", () => ({ resolveKiroModels: mocks.kiroModels }));
vi.mock("open-sse/index.js", () => ({ getExecutor: () => ({ execute: mocks.execute, refreshCredentials: mocks.executorRefresh }) }));
vi.mock("next/server", () => ({
  NextResponse: { json: (body, init = {}) => Response.json(body, { status: init.status || 200 }) },
}));
const db = vi.hoisted(() => ({
  getProviderConnections: mocks.connections,
  getProviderConnectionById: mocks.getById,
  updateProviderConnection: mocks.update,
  getCombos: async () => [],
  getCustomModels: async () => [],
  getModelAliases: async () => ({}),
}));
vi.mock("../../src/lib/localDb.js", () => db);
vi.mock("../../src/models/index.js", () => db);
vi.mock("../../src/lib/disabledModelsDb.js", () => ({ getDisabledModels: async () => ({}) }));

import { createHash } from "node:crypto";
import { handleChatCore } from "../../open-sse/handlers/chatCore.js";
import { handleImageGenerationCore } from "../../open-sse/handlers/imageGenerationCore.js";
import { handleEmbeddingsCore } from "../../open-sse/handlers/embeddingsCore.js";
import { handleVideoProxyCore } from "../../open-sse/handlers/videoCore.js";
import { POST as translatorSend } from "../../src/app/api/translator/send/route.js";
import { refreshAndUpdateCredentials } from "../../src/app/api/usage/[connectionId]/route.js";
import { GET as dashboardModels } from "../../src/app/api/providers/[id]/models/route.js";
import { buildModelsList } from "../../src/app/api/v1/models/route.js";
import { checkAndRefreshToken } from "../../src/sse/services/tokenRefresh.js";

const originalFetch = global.fetch;
const kiroPatch = { authMethod: "external_idp", clientId: "client-id", tokenEndpoint: "https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token", scope: "offline_access" };
const refreshed = { accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 3600, providerSpecificData: kiroPatch };
const stored = () => ({
  accessToken: "old-access", refreshToken: "old-refresh",
  providerSpecificData: { ...kiroPatch, accountId: "acct", profileArn: "profile-1", region: "eu-west-1" },
});
const expectedData = { ...kiroPatch, accountId: "acct", profileArn: "profile-1", region: "eu-west-1" };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const dbDown = () => mocks.update.mockRejectedValue(new Error("database is locked"));
const failingCallback = () => vi.fn().mockRejectedValue(new Error("database is locked"));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.executorRefresh.mockResolvedValue(refreshed);
  mocks.refreshByProvider.mockResolvedValue(refreshed);
  mocks.update.mockImplementation(async (id, data) => ({ id, ...data }));
});

afterEach(() => {
  global.fetch = originalFetch;
});

const imageRequest = (credentials, onCredentialsRefreshed) => handleImageGenerationCore({
  body: { prompt: "hello" }, modelInfo: { provider: "test-provider", model: "m" }, credentials, onCredentialsRefreshed,
});
const embeddingsRequest = (credentials, onCredentialsRefreshed) => handleEmbeddingsCore({
  body: { input: "hello" }, modelInfo: { provider: "test-provider", model: "m" }, credentials, onCredentialsRefreshed,
});
const videoRequest = (credentials, onCredentialsRefreshed) => handleVideoProxyCore({
  provider: "xai", action: "generations", rawBody: "{}", contentType: "application/json", credentials, onCredentialsRefreshed,
});
const translatorRequest = () => translatorSend(new Request("http://localhost/api/translator/send", {
  method: "POST", body: JSON.stringify({ provider: "kiro", model: "m", body: { stream: true } }),
}));
function translatorExecutor() {
  const seen = [];
  mocks.connections.mockResolvedValue([{ id: "conn-1", isActive: true, ...stored() }]);
  mocks.execute.mockImplementation(async ({ credentials }) => {
    seen.push(structuredClone(credentials));
    return { response: seen.length === 1 ? json({ error: "expired" }, 401) : new Response("data: ok\n\n") };
  });
  return seen;
}

// A Kiro IDC account, and the patch its refresh returns when it looks up a missing profile.
const idcAccount = () => ({
  accessToken: "old-access", refreshToken: "old-refresh",
  providerSpecificData: { authMethod: "idc", region: "eu-west-1", clientId: "client-1" },
});
const profilePatch = { profileArn: "arn:aws:codewhisperer:eu-west-1:000000000000:profile/EXAMPLE" };

describe("retry after a patch-only refresh keeps the request's other credential fields", () => {
  it("chat", async () => {
    const seen = [];
    mocks.execute.mockImplementation(async ({ credentials }) => {
      seen.push({ accessToken: credentials.accessToken, providerSpecificData: { ...credentials.providerSpecificData } });
      const response = seen.length === 1
        ? json({ error: { message: "expired" } }, 401)
        : json({ id: "c1", object: "chat.completion", model: "m", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      return { response, url: "https://chat.example.test", headers: {}, transformedBody: {} };
    });
    mocks.executorRefresh.mockResolvedValueOnce({ accessToken: "new-access", providerSpecificData: profilePatch });
    const body = { model: "m", stream: false, messages: [{ role: "user", content: "Hi" }] };
    await handleChatCore({
      body, modelInfo: { provider: "openai", model: "m" }, credentials: idcAccount(),
      clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: {} }, connectionId: "conn-1",
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    expect(seen).toHaveLength(2);
    expect(seen[1].accessToken).toBe("new-access");
    expect(seen[1].providerSpecificData).toMatchObject({ authMethod: "idc", region: "eu-west-1", clientId: "client-1", ...profilePatch });
  });

  it("Kiro model catalog", async () => {
    const { resolveKiroModels } = await vi.importActual("../../open-sse/services/kiroModels.js");
    global.fetch = vi.fn()
      .mockResolvedValueOnce(json({ message: "expired" }, 401))
      .mockResolvedValueOnce(json({ models: [{ modelId: "kiro-model" }] }));
    mocks.refreshKiro.mockResolvedValueOnce({ accessToken: "new-access", providerSpecificData: profilePatch });
    const result = await resolveKiroModels(idcAccount(), { forceRefresh: true });
    expect(result?.models?.length).toBeGreaterThan(0);
    const [url, init] = global.fetch.mock.calls[1];
    expect(url).toContain("profileArn=" + encodeURIComponent(profilePatch.profileArn));
    expect(init.headers.Authorization).toBe("Bearer new-access");
    // The fingerprint is seeded from clientId: still there on the retry.
    const machineId = createHash("sha256").update("client-1").digest("hex");
    expect(init.headers["User-Agent"]).toContain(machineId);
  });

  it("image generation", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(json({ error: "expired" }, 401)).mockResolvedValueOnce(json({ created: 1, data: [] }));
    const onCredentialsRefreshed = vi.fn();
    const result = await imageRequest(stored(), onCredentialsRefreshed);
    expect(result.success).toBe(true);
    const [url, init] = global.fetch.mock.calls[1];
    expect(url).toBe("https://images.example.test/eu-west-1");
    expect(init.headers).toMatchObject({ Authorization: "Bearer new-access", "X-Account": "acct" });
    expect(onCredentialsRefreshed).toHaveBeenCalledWith(refreshed);
  });

  it("embeddings", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(json({ error: "expired" }, 401)).mockResolvedValueOnce(json({ object: "list", data: [], usage: {} }));
    const credentials = stored();
    const result = await embeddingsRequest(credentials);
    expect(result.success).toBe(true);
    const [url, init] = global.fetch.mock.calls[1];
    expect(url).toBe("https://embeddings.example.test/eu-west-1");
    expect(init.headers).toMatchObject({ Authorization: "Bearer new-access", "X-Account": "acct" });
    expect(credentials.providerSpecificData).toEqual(expectedData);
  });

  it("video", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(json({ error: "expired" }, 401)).mockResolvedValueOnce(json({ request_id: "job" }));
    const credentials = stored();
    const result = await videoRequest(credentials);
    expect(result.success).toBe(true);
    expect(global.fetch.mock.calls[1][1].headers.Authorization).toBe("Bearer new-access");
    expect(credentials.providerSpecificData).toEqual(expectedData);
  });

  it("translator send, which also saves the result through updateProviderCredentials", async () => {
    const seen = translatorExecutor();
    const response = await translatorRequest();
    expect(response.status).toBe(200);
    expect(seen[1]).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh", providerSpecificData: expectedData });
    expect(mocks.update).toHaveBeenCalledWith("conn-1",
      expect.objectContaining({ accessToken: "new-access", refreshToken: "new-refresh", providerSpecificData: kiroPatch }),
      expect.objectContaining({ patchProviderSpecificData: true }));
  });
});

describe("a failed save of refreshed tokens doesn't fail the request", () => {
  it("image generation", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(json({ error: "expired" }, 401)).mockResolvedValueOnce(json({ created: 1, data: [] }));
    expect((await imageRequest(stored(), failingCallback())).success).toBe(true);
  });

  it("embeddings", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(json({ error: "expired" }, 401)).mockResolvedValueOnce(json({ object: "list", data: [], usage: {} }));
    expect((await embeddingsRequest(stored(), failingCallback())).success).toBe(true);
  });

  it("video", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(json({ error: "expired" }, 401)).mockResolvedValueOnce(json({ request_id: "job" }));
    expect((await videoRequest(stored(), failingCallback())).success).toBe(true);
  });

  it("translator send still streams the retry", async () => {
    dbDown();
    const seen = translatorExecutor();
    const response = await translatorRequest();
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen[1].accessToken).toBe("new-access");
  });

  it("usage polling goes on with the new tokens", async () => {
    dbDown();
    mocks.getById.mockResolvedValue({ id: "conn-1", provider: "kiro", ...stored() });
    const { connection, refreshed: didRefresh } = await refreshAndUpdateCredentials({ id: "conn-1" }, true);
    expect(didRefresh).toBe(true);
    expect(connection).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh", providerSpecificData: expectedData });
  });

  it("the dashboard model list still retries with the refreshed token", async () => {
    dbDown();
    mocks.getById.mockResolvedValue({ id: "conn-1", provider: "codex", accessToken: "old-access", refreshToken: "old-refresh" });
    global.fetch = vi.fn(async (url, init) => {
      if (String(url).includes("/token")) return json({ access_token: "codex-new-access", refresh_token: "codex-new-refresh", expires_in: 3600 });
      return init?.headers?.Authorization === "Bearer codex-new-access" ? json({ models: [] }) : json({ error: "expired" }, 401);
    });
    const response = await dashboardModels(new Request("http://localhost/api/providers/conn-1/models"), { params: Promise.resolve({ id: "conn-1" }) });
    expect(response.status).toBe(200);
    const modelCalls = global.fetch.mock.calls.filter(([url]) => !String(url).includes("/token"));
    expect(modelCalls.map(([, init]) => init.headers.Authorization)).toEqual(["Bearer old-access", "Bearer codex-new-access"]);
  });

  it("the proactive Copilot refresh keeps the new token", async () => {
    dbDown();
    mocks.getById.mockResolvedValue(null);
    global.fetch = vi.fn(async () => json({ token: "fresh-copilot", expires_at: 4102444800 }));
    const result = await checkAndRefreshToken("github", {
      connectionId: "conn-1", accessToken: "gh-access", expiresAt: "2099-01-01T00:00:00.000Z", providerSpecificData: {},
    });
    expect(result.providerSpecificData.copilotToken).toBe("fresh-copilot");
  });
});

describe("/v1/models Kiro live catalog", () => {
  it("saves tokens the catalog lookup refreshed", async () => {
    mocks.connections.mockResolvedValue([{ id: "kiro-1", provider: "kiro", isActive: true, ...stored() }]);
    mocks.kiroModels.mockImplementation(async (_credentials, options) => {
      await options.onCredentialsRefreshed(refreshed);
      return { models: [{ id: "kiro-live-model" }] };
    });
    await buildModelsList(["llm"]);
    expect(mocks.kiroModels).toHaveBeenCalledOnce();
    expect(mocks.update).toHaveBeenCalledWith("kiro-1",
      expect.objectContaining({ accessToken: "new-access", refreshToken: "new-refresh", providerSpecificData: kiroPatch }),
      expect.objectContaining({ patchProviderSpecificData: true }));
  });
});
