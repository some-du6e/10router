import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeErrorMessage, testSingleConnection } from "../../src/app/api/providers/[id]/test/testUtils.js";

const { get, update, refresh, expired } = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), refresh: vi.fn(), expired: vi.fn() }));
vi.mock("@/lib/localDb", () => ({ getProviderConnectionById: get, updateProviderConnection: update }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: async () => ({}) }));
vi.mock("open-sse/services/oauthCredentialManager.js", () => ({ refreshProviderCredentials: refresh, shouldRefreshCredentials: expired }));

const connection = { id: "account-a", provider: "codex", authType: "oauth", accessToken: "old-access", refreshToken: "old-refresh" };
const rotated = { accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 3600 };
// The token endpoint reply for providers refreshed inline (Google uses snake_case, Cline camelCase).
const tokenReply = () => Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600,
  accessToken: "new-access", refreshToken: "new-refresh" });

const tokenWrites = () => update.mock.calls.filter(([, data]) => "accessToken" in data);
const statusWrites = () => update.mock.calls.filter(([, data]) => "testStatus" in data);
const expectTokensSaved = () => {
  expect(tokenWrites()).toEqual([["account-a", expect.objectContaining({ accessToken: "new-access", refreshToken: "new-refresh" }),
    { refreshTokenUsed: "old-refresh" }]]);
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
  vi.clearAllMocks();
  get.mockResolvedValue({ ...connection });
  update.mockResolvedValue({});
  refresh.mockResolvedValue({ ...rotated });
  expired.mockReturnValue(false);
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
    expect(statusWrites()).toEqual([["account-a", expect.objectContaining({ testStatus: "error" })]]);
  });

  it("leaves a row alone once a newer login replaced the refresh token the test used", async () => {
    update.mockImplementation(async (_id, _data, opts) => (opts?.refreshTokenUsed === "old-refresh" ? null : {}));
    stubFetch(status(401), status(403));
    expect(await testSingleConnection("account-a")).toMatchObject({ valid: false, refreshed: true });
    expect(update).toHaveBeenCalledTimes(1);
    expect(statusWrites()).toEqual([]);
  });
});

describe("connection test errors never carry a credential", () => {
  const secret = "secret-token-value";

  it("turns Node's invalid-header error into a fixed message", () => {
    let err;
    try { new Headers({ Authorization: `Bearer ${secret}\nmore` }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(TypeError);
    expect(probeErrorMessage(err, [secret])).toBe("Malformed access token");
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
    expect(result.error).toBe("connect failed for [REDACTED]");
    expect(JSON.stringify(update.mock.calls)).not.toContain(secret);
  });
});
