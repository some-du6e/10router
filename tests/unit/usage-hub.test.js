import { beforeEach, describe, expect, it, vi } from "vitest";
import { authorizeHub, createManagementKey, hashManagementKey } from "../../src/lib/usageHub/auth.js";

const db = vi.hoisted(() => ({ getSettings: vi.fn(), updateSettings: vi.fn(), getProviderConnections: vi.fn(), getProviderConnectionById: vi.fn(), updateProviderConnection: vi.fn() }));
const upstream = vi.hoisted(() => ({ fetch: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/db/index.js", () => db);
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: upstream.fetch }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: async () => ({}) }));
vi.mock("@/app/api/usage/[connectionId]/route.js", () => ({ refreshAndUpdateCredentials: upstream.refresh }));

import { hubApiCall, listHubAccounts, resetHubQuota } from "../../src/lib/usageHub/service.js";
import { GET, POST } from "../../src/app/v0/management/[action]/route.js";
import * as configRoute from "../../src/app/api/settings/usage-hub/route.js";

const usageUrl = "https://chatgpt.com/backend-api/wham/usage";
const creditsUrl = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const account = { id: "test-account", provider: "codex", authType: "oauth", isActive: true, accessToken: "secret-access", refreshToken: "secret-refresh", email: "test@example.test", providerSpecificData: { accountId: "workspace" } };
let settings;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TENROUTER_HUB_DEMO", "false");
  settings = { usageHubEnabled: true, usageHubKeyHash: hashManagementKey("test-key") };
  db.getSettings.mockImplementation(async () => settings);
  db.updateSettings.mockImplementation(async (body) => (settings = { ...settings, ...body }));
  db.getProviderConnections.mockResolvedValue([account]);
  db.getProviderConnectionById.mockResolvedValue(account);
  upstream.refresh.mockImplementation(async (connection) => ({ connection }));
  upstream.fetch.mockResolvedValue(Response.json({ plan_type: "plus", rate_limit: null }));
});

describe("hub authentication and settings", () => {
  it("defaults to denied, rejects wrong keys, and accepts the dedicated key", () => {
    const request = (key) => new Request("http://localhost", { headers: { Authorization: `Bearer ${key}` } });
    expect(authorizeHub(request("test-key"), {})).toBe(404);
    expect(authorizeHub(request("wrong"), settings)).toBe(401);
    expect(authorizeHub(request("test-key"), settings)).toBeNull();
    expect(authorizeHub(request("test-key"), { ...settings, usageHubKeyHash: "bad" })).toBe(401);
    const generated = createManagementKey();
    expect(generated.hash).toBe(hashManagementKey(generated.key));
    expect(createManagementKey().key).not.toBe(generated.key);
  });

  it("generates a key on first enable, never returns its hash, and revokes old keys on rotation", async () => {
    settings = {};
    const response = await configRoute.PATCH(new Request("http://localhost", { method: "PATCH", body: JSON.stringify({ enabled: true }) }));
    const enabled = await response.json();
    expect(enabled.managementKey).toMatch(/^hub_/);
    expect(enabled.usageHubKeyHash).toBeUndefined();
    expect(await (await configRoute.GET()).json()).toEqual({ enabled: true, keyConfigured: true, demo: false });
    const rotated = await (await configRoute.POST()).json();
    expect(rotated.managementKey).not.toBe(enabled.managementKey);
    expect(authorizeHub(new Request("http://localhost", { headers: { Authorization: `Bearer ${enabled.managementKey}` } }), settings)).toBe(401);
    expect((await configRoute.PATCH(new Request("http://localhost", { method: "PATCH", body: '{"enabled":"true"}' }))).status).toBe(400);
  });
});

describe("CLIProxyAPI contract", () => {
  it("lists metadata without credentials and filters unsupported accounts", async () => {
    db.getProviderConnections.mockResolvedValue([account, { ...account, id: "disabled", isActive: false }, { ...account, provider: "kiro" }]);
    const result = await listHubAccounts();
    expect(result.files).toHaveLength(2);
    expect(result.files[0]).toMatchObject({ id: account.id, auth_index: account.id, id_token: { chatgpt_account_id: "workspace" } });
    expect(result.files[1].disabled).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret-");
  });

  it("returns the raw quota envelope with server-built account credentials", async () => {
    const result = await hubApiCall({ auth_index: account.id, method: "GET", url: usageUrl, header: { Authorization: "attacker", Cookie: "attacker" } });
    expect(result.status_code).toBe(200);
    expect(JSON.parse(result.body).plan_type).toBe("plus");
    const [url, init] = upstream.fetch.mock.calls[0];
    expect(url).toBe(usageUrl);
    expect(init.headers.Authorization).toBe("Bearer secret-access");
    expect(init.headers["ChatGPT-Account-ID"]).toBe("workspace");
    expect(init.headers.Cookie).toBeUndefined();
    expect(init.redirect).toBe("error");
  });

  it.each(["http://127.0.0.1/secrets", `${usageUrl}?x=1`, `${usageUrl}/../other`, "https://attacker.test/"])("blocks arbitrary destination %s", async (url) => {
    await expect(hubApiCall({ auth_index: account.id, method: "GET", url })).rejects.toMatchObject({ status: 403 });
    expect(upstream.fetch).not.toHaveBeenCalled();
  });

  it("rejects cross-provider quota calls and inactive accounts", async () => {
    db.getProviderConnectionById.mockResolvedValue({ ...account, provider: "claude" });
    await expect(hubApiCall({ auth_index: account.id, method: "GET", url: usageUrl })).rejects.toMatchObject({ status: 403 });
    db.getProviderConnectionById.mockResolvedValue({ ...account, isActive: false });
    await expect(hubApiCall({ auth_index: account.id, method: "GET", url: usageUrl })).rejects.toMatchObject({ status: 404 });
  });

  it("refreshes expired OAuth credentials once and retries", async () => {
    upstream.fetch.mockResolvedValueOnce(Response.json({}, { status: 401 })).mockResolvedValueOnce(Response.json({ rate_limit: null }));
    await hubApiCall({ auth_index: account.id, method: "GET", url: usageUrl });
    expect(upstream.refresh).toHaveBeenNthCalledWith(2, account, true, {});
    expect(upstream.fetch).toHaveBeenCalledTimes(2);
  });

  it("requires a confirmed redemption before clearing persisted cooldowns", async () => {
    await expect(resetHubQuota({ auth_index: account.id })).rejects.toMatchObject({ status: 409 });
    db.getProviderConnectionById.mockResolvedValue({ ...account, modelLock_test: "later" });
    upstream.fetch.mockResolvedValueOnce(Response.json({ code: "reset" }));
    await hubApiCall({ auth_index: account.id, method: "POST", url: `${creditsUrl}/consume`, data: JSON.stringify({ credit_id: "credit", redeem_request_id: "request" }) });
    expect(JSON.parse(upstream.fetch.mock.calls[0][1].body)).toEqual({ credit_id: "credit", redeem_request_id: "request" });
    expect(await resetHubQuota({ auth_index: account.id })).toEqual({ status: "ok" });
    expect(db.updateProviderConnection).toHaveBeenCalledWith(account.id, expect.objectContaining({ modelLock_test: null, rateLimitedUntil: null }));
    await expect(resetHubQuota({ auth_index: account.id })).rejects.toMatchObject({ status: 409 });
  });

  it("serves fake subscriptions and reset credits without DB or network access", async () => {
    vi.stubEnv("TENROUTER_HUB_DEMO", "true");
    const { files } = await listHubAccounts();
    expect(files).toHaveLength(4);
    const id = "demo-codex-exhausted";
    const call = (url, method = "GET", data) => hubApiCall({ auth_index: id, url, method, data });
    expect(JSON.parse((await call(usageUrl)).body).rate_limit.primary_window.used_percent).toBe(100);
    const credit = JSON.parse((await call(creditsUrl)).body).credits[0];
    const data = JSON.stringify({ credit_id: credit.id, redeem_request_id: "demo-request" });
    expect(JSON.parse((await call(`${creditsUrl}/consume`, "POST", data)).body).code).toBe("reset");
    expect(JSON.parse((await call(`${creditsUrl}/consume`, "POST", data)).body).code).toBe("already_redeemed");
    expect(JSON.parse((await call(usageUrl)).body).rate_limit.primary_window.used_percent).toBe(0);
    expect(upstream.fetch).not.toHaveBeenCalled();
    expect(db.getProviderConnections).not.toHaveBeenCalled();
  });

  it("checks auth before parsing, validates JSON and rejects unknown routes", async () => {
    const ctx = (action) => ({ params: Promise.resolve({ action }) });
    const req = (body, key = "test-key") => new Request("http://localhost/v0/management/api-call", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body });
    expect((await POST(req("invalid", "wrong"), ctx("api-call"))).status).toBe(401);
    expect((await POST(req("invalid"), ctx("api-call"))).status).toBe(400);
    expect((await POST(req("null"), ctx("api-call"))).status).toBe(400);
    expect((await POST(req("{}"), ctx("unknown"))).status).toBe(404);
    expect((await POST(req("{}"), ctx("auth-files"))).status).toBe(405);
    settings.usageHubEnabled = false;
    expect((await GET(new Request("http://localhost"), ctx("auth-files"))).status).toBe(404);
  });
});
