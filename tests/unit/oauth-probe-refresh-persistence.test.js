import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeErrorMessage, testSingleConnection } from "../../src/app/api/providers/[id]/test/testUtils.js";

const { get, update, refresh, expired, lock, proxyConfig, proxyTest } = vi.hoisted(() => ({
  get: vi.fn(), update: vi.fn(), refresh: vi.fn(), expired: vi.fn(), lock: vi.fn(), proxyConfig: vi.fn(), proxyTest: vi.fn(),
}));
vi.mock("@/lib/localDb", () => ({ getProviderConnectionById: get, updateProviderConnection: update }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: proxyConfig }));
vi.mock("@/lib/network/proxyTest", () => ({ testProxyUrl: proxyTest }));
vi.mock("open-sse/services/oauthCredentialManager.js", () => ({
  refreshProviderCredentials: refresh, shouldRefreshCredentials: expired, withCredentialRefreshLock: lock,
}));

const connection = { id: "account-a", provider: "codex", authType: "oauth", accessToken: "old-access", refreshToken: "old-refresh" };
const rotated = { accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 3600 };
// The token endpoint reply for providers refreshed inline (Google uses snake_case, Cline camelCase).
const tokenReply = () => Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600,
  accessToken: "new-access", refreshToken: "new-refresh" });

const tokenWrites = () => update.mock.calls.filter(([, data]) => "accessToken" in data);
const statusWrites = () => update.mock.calls.filter(([, data]) => "testStatus" in data);
const expectTokensSaved = () => {
  expect(tokenWrites()).toEqual([["account-a", expect.objectContaining({ accessToken: "new-access", refreshToken: "new-refresh" }),
    { refreshTokenUsed: ["old-refresh", "new-refresh"] }]]);
};
const stubFetch = (...replies) => {
  const fetch = vi.fn();
  for (const reply of replies) {
    if (reply instanceof Error) fetch.mockRejectedValueOnce(reply);
    else fetch.mockImplementationOnce(async () => (typeof reply === "function" ? reply() : reply));
  }
  vi.stubGlobal("fetch", fetch);
  return fetch;
};
const status = (code, body = "probe failed") => () => new Response(body, { status: code });

beforeEach(() => {
  vi.resetAllMocks();
  get.mockResolvedValue({ ...connection });
  update.mockResolvedValue({});
  refresh.mockResolvedValue({ ...rotated });
  expired.mockReturnValue(false);
  lock.mockImplementation(async (_provider, _credentials, refreshFn) => refreshFn());
  proxyConfig.mockResolvedValue({});
});
afterEach(() => vi.unstubAllGlobals());

describe("connection tests save a token refresh as soon as it succeeds", () => {
  it.each([[403, "Access denied"], [500, "API returned 500"]])(
    "saves rotated tokens when the retry after a 401 returns %s, and reports the retry's error", async (code, error) => {
      const fetch = stubFetch(status(401), status(code));
      expect(await testSingleConnection("account-a")).toMatchObject({ valid: false, refreshed: true, error });
      expectTokensSaved();
      expect(tokenWrites()[0][1]).toMatchObject({ expiresIn: 3600, expiresAt: expect.any(String) });
      expect(statusWrites()).toEqual([["account-a", expect.objectContaining({ testStatus: "error", lastError: error }),
        { refreshTokenUsed: "new-refresh" }]]);
      expect(fetch.mock.calls[1][1].headers.Authorization).toBe("Bearer new-access");
      expect(refresh).toHaveBeenCalledTimes(1);
    });

  it("saves the tokens before the retry probe runs", async () => {
    let writesBeforeRetry = null;
    stubFetch(status(401), () => {
      writesBeforeRetry = tokenWrites().length;
      return new Response("ok", { status: 400 });
    });
    expect(await testSingleConnection("account-a")).toMatchObject({ valid: true, refreshed: true });
    expect(writesBeforeRetry).toBe(1);
    expect(statusWrites()[0][1]).toMatchObject({ testStatus: "active" });
  });

  it("saves rotated tokens when the retry throws", async () => {
    stubFetch(status(401), new Error("probe timeout"));
    expect(await testSingleConnection("account-a")).toMatchObject({ valid: false, refreshed: true, error: "probe timeout" });
    expectTokensSaved();
  });

  it("saves a proactive refresh even when the first probe fails", async () => {
    expired.mockReturnValue(true);
    stubFetch(status(403, "denied"));
    expect(await testSingleConnection("account-a")).toMatchObject({ valid: false, refreshed: true, error: "Access denied" });
    expectTokensSaved();
  });

  it.each(["gemini-cli", "antigravity", "cline"])("saves %s rotation when its probe throws", async (provider) => {
    get.mockResolvedValue({ ...connection, provider });
    expired.mockReturnValue(true);
    stubFetch(tokenReply, new Error("provider unreachable"));
    expect(await testSingleConnection("account-a")).toMatchObject({ valid: false, refreshed: true, error: "provider unreachable" });
    expectTokensSaved();
  });

  it.each(["gemini-cli", "antigravity"])("saves %s rotation when its probe returns 403", async (provider) => {
    get.mockResolvedValue({ ...connection, provider });
    expired.mockReturnValue(true);
    stubFetch(tokenReply, () => Response.json({ error: { message: "Project denied" } }, { status: 403 }));
    expect(await testSingleConnection("account-a")).toMatchObject({ valid: false, refreshed: true, error: "Project denied" });
    expectTokensSaved();
  });

  it.each([[status(403), "Access denied"], [status(500), "API returned 500"], [new Error("cline down"), "cline down"]])(
    "saves Cline rotation when the retry after a 401 fails (%#)", async (retry, error) => {
      get.mockResolvedValue({ ...connection, provider: "cline" });
      stubFetch(status(401), tokenReply, retry);
      expect(await testSingleConnection("account-a")).toMatchObject({ valid: false, refreshed: true, error });
      expectTokensSaved();
    });

  it("does not refresh Cline a second time with a refresh token it just used", async () => {
    get.mockResolvedValue({ ...connection, provider: "cline" });
    expired.mockReturnValue(true);
    const fetch = stubFetch(tokenReply, status(401));
    expect(await testSingleConnection("account-a")).toMatchObject({ valid: false, refreshed: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expectTokensSaved();
  });

  it("does not report or save a refresh without an access token", async () => {
    refresh.mockResolvedValue({ refreshToken: "incomplete" });
    stubFetch(status(401));
    expect(await testSingleConnection("account-a")).toMatchObject({ valid: false, refreshed: false, error: "Token invalid or revoked" });
    expect(tokenWrites()).toEqual([]);
    expect(statusWrites()).toEqual([["account-a", expect.objectContaining({ testStatus: "error" }), { refreshTokenUsed: "old-refresh" }]]);
  });

  it("keeps the refresh token when the provider doesn't rotate it", async () => {
    refresh.mockResolvedValue({ accessToken: "new-access", expiresIn: 3600 });
    stubFetch(status(401), status(400));
    expect(await testSingleConnection("account-a")).toMatchObject({ valid: true, refreshed: true });
    expect(tokenWrites()).toEqual([["account-a", expect.objectContaining({ accessToken: "new-access", refreshToken: "old-refresh" }),
      { refreshTokenUsed: ["old-refresh"] }]]);
    expect(statusWrites()).toEqual([["account-a", expect.objectContaining({ testStatus: "active" }), { refreshTokenUsed: "old-refresh" }]]);
  });

  it("records a test without a refresh only while the row still holds the token it tested", async () => {
    stubFetch(status(403));
    expect(await testSingleConnection("account-a")).toMatchObject({ valid: false, refreshed: false });
    expect(update).toHaveBeenCalledTimes(1);
    expect(statusWrites()).toEqual([["account-a", expect.objectContaining({ testStatus: "error" }), { refreshTokenUsed: "old-refresh" }]]);
  });

  it("uses the stored tokens instead of refreshing when another login rotated them first", async () => {
    get.mockResolvedValueOnce({ ...connection })
      .mockResolvedValueOnce({ ...connection, accessToken: "request-access", refreshToken: "request-refresh" });
    const fetch = stubFetch(status(401), status(400));
    expect(await testSingleConnection("account-a")).toMatchObject({ valid: true, refreshed: false });
    expect(refresh).not.toHaveBeenCalled();
    expect(fetch.mock.calls[1][1].headers.Authorization).toBe("Bearer request-access");
    expect(tokenWrites()).toEqual([]);
    expect(statusWrites()).toEqual([["account-a", expect.objectContaining({ testStatus: "active" }), { refreshTokenUsed: "request-refresh" }]]);
  });

  it("refreshes adopted tokens once, with the stored refresh token, when they are refused", async () => {
    const stored = { ...connection, accessToken: "request-access", refreshToken: "request-refresh" };
    get.mockResolvedValueOnce({ ...connection }).mockResolvedValue(stored);
    const fetch = stubFetch(status(401), status(401), status(400));
    expect(await testSingleConnection("account-a")).toMatchObject({ valid: true, refreshed: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0][1]).toMatchObject({ refreshToken: "request-refresh" });
    expect(fetch.mock.calls.map(([, init]) => init.headers.Authorization))
      .toEqual(["Bearer old-access", "Bearer request-access", "Bearer new-access"]);
    expect(tokenWrites()).toEqual([["account-a", expect.objectContaining({ accessToken: "new-access", refreshToken: "new-refresh" }),
      { refreshTokenUsed: ["request-refresh", "new-refresh"] }]]);
    expect(statusWrites()).toEqual([["account-a", expect.objectContaining({ testStatus: "active" }), { refreshTokenUsed: "new-refresh" }]]);
  });

  it("records nothing once another login left the row without an access token", async () => {
    get.mockResolvedValueOnce({ ...connection }).mockResolvedValue({ ...connection, accessToken: null, refreshToken: "request-refresh" });
    stubFetch(status(401));
    expect(await testSingleConnection("account-a")).toMatchObject({ valid: false, refreshed: false });
    expect(refresh).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("records nothing once the row was deleted during the test", async () => {
    get.mockResolvedValueOnce({ ...connection }).mockResolvedValue(null);
    stubFetch(status(401));
    expect(await testSingleConnection("account-a")).toMatchObject({ valid: false, refreshed: false });
    expect(refresh).not.toHaveBeenCalled();
    expect(statusWrites()).toEqual([]);
  });

  it("does not report a refresh it couldn't save, nor record a status, once a newer login replaced the tokens", async () => {
    update.mockImplementation(async (_id, _data, opts) => (Array.isArray(opts?.refreshTokenUsed) ? null : {}));
    stubFetch(status(401), status(403));
    expect(await testSingleConnection("account-a")).toMatchObject({ valid: false, refreshed: false });
    expect(update).toHaveBeenCalledTimes(1);
    expect(statusWrites()).toEqual([]);
  });

  it("records a proxy failure on an OAuth row only while it holds the tokens the test read", async () => {
    proxyConfig.mockResolvedValue({ connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.example.test:3128" });
    proxyTest.mockResolvedValue({ ok: false, error: "proxy down" });
    expect(await testSingleConnection("account-a")).toMatchObject({ valid: false, error: "proxy down" });
    expect(statusWrites()).toEqual([["account-a", expect.objectContaining({ testStatus: "error", lastError: "proxy down" }),
      { refreshTokenUsed: "old-refresh" }]]);
  });
});

describe("connection tests share the request path's refresh lock", () => {
  it.each(["claude", "gemini-cli", "antigravity", "kiro", "cline"])("refreshes %s inside withCredentialRefreshLock", async (provider) => {
    get.mockResolvedValue({ ...connection, provider });
    expired.mockReturnValue(true);
    stubFetch(tokenReply, status(200));
    await testSingleConnection("account-a");
    expect(lock).toHaveBeenCalledWith(provider, expect.objectContaining({ id: "account-a", refreshToken: "old-refresh" }), expect.any(Function));
    expectTokensSaved();
  });

  it("takes a refresh a request already started instead of spending the token again", async () => {
    get.mockResolvedValue({ ...connection, provider: "gemini-cli" });
    expired.mockReturnValue(true);
    lock.mockImplementation(async () => ({ accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 3600 }));
    const fetch = stubFetch(status(200));
    expect(await testSingleConnection("account-a")).toMatchObject({ valid: true, refreshed: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).not.toContain("oauth2.googleapis.com");
    expectTokensSaved();
  });

  it("leaves Codex to refreshProviderCredentials, which takes the lock itself", async () => {
    expired.mockReturnValue(true);
    stubFetch(status(400));
    await testSingleConnection("account-a");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(lock).not.toHaveBeenCalled();
  });
});

describe("connection test errors never carry a credential", () => {
  const secret = "secret-token-value";

  it("turns Node's invalid-header error into a fixed message", () => {
    let err;
    try { new Headers({ Authorization: `Bearer ${secret}\nmore` }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(TypeError);
    expect(probeErrorMessage(err, [{ accessToken: secret }])).toBe("Malformed access token");
  });

  it("passes other TypeErrors through", () => {
    const err = new TypeError("Cannot read properties of undefined (reading 'headers')");
    expect(probeErrorMessage(err, [{ accessToken: secret }])).toBe("Cannot read properties of undefined (reading 'headers')");
  });

  it("never throws on a credential that can't be URL-encoded", () => {
    const loneSurrogate = "token-\uD800-value";
    expect(probeErrorMessage(new Error(`failed for ${loneSurrogate}`), [{ accessToken: loneSurrogate }])).toBe("failed for [redacted]");
  });

  it("stores the fixed message when a malformed token makes the probe throw", async () => {
    get.mockResolvedValue({ ...connection, accessToken: `${secret}\nmore` });
    stubFetch(new TypeError(`Headers.append: "Bearer ${secret}\nmore" is an invalid header value.`));
    expect(await testSingleConnection("account-a")).toMatchObject({ valid: false, error: "Malformed access token" });
    expect(statusWrites()[0][1].lastError).toBe("Malformed access token");
  });

  it("redacts a token that appears in any other probe error", async () => {
    get.mockResolvedValue({ ...connection, accessToken: secret });
    stubFetch(new Error(`connect failed for ${secret}`));
    const result = await testSingleConnection("account-a");
    expect(result.error).toBe("connect failed for [redacted]");
    expect(JSON.stringify(update.mock.calls)).not.toContain(secret);
  });

  it("redacts the refreshed access token from a retry that throws", async () => {
    const refreshedToken = "rotated-access-token-0123456789abcdef";
    refresh.mockResolvedValue({ ...rotated, accessToken: refreshedToken });
    stubFetch(status(401), new Error(`upstream rejected ${refreshedToken} during retry`));
    const result = await testSingleConnection("account-a");
    expect(result.error).toBe("upstream rejected [redacted] during retry");
    expect(JSON.stringify(statusWrites())).not.toContain(refreshedToken);
  });

  it("redacts adopted stored tokens from a probe that throws", async () => {
    const storedToken = "stored-access-token-0123456789abcdef";
    get.mockResolvedValueOnce({ ...connection })
      .mockResolvedValue({ ...connection, accessToken: storedToken, refreshToken: "request-refresh" });
    stubFetch(status(401), new Error(`upstream rejected ${storedToken} after re-read`));
    const result = await testSingleConnection("account-a");
    expect(result.error).toBe("upstream rejected [redacted] after re-read");
    expect(JSON.stringify(statusWrites())).not.toContain(storedToken);
  });
});
