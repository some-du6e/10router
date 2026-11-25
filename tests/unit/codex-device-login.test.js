import { afterEach, expect, it, vi } from "vitest";
import { GET, POST } from "../../src/app/api/oauth/[provider]/[action]/route.js";

const { createConnection } = vi.hoisted(() => ({ createConnection: vi.fn() }));
vi.mock("@/models", () => ({ createProviderConnection: createConnection }));
vi.mock("next/server", () => ({ NextResponse: { json: (body, init) => Response.json(body, init) } }));

const context = (action) => ({ params: Promise.resolve({ provider: "codex", action }) });
const requestCode = () => GET(new Request("http://localhost/api/oauth/codex/device-code"), context("device-code"));
const poll = (extraData = { userCode: "ABCD-1234" }) => POST(
  new Request("http://localhost/api/oauth/codex/poll", {
    method: "POST",
    body: JSON.stringify({ deviceCode: "device-auth-id", extraData }),
  }),
  context("poll"),
);

afterEach(() => {
  vi.unstubAllGlobals();
  createConnection.mockReset();
});

it("exchanges the approved device code with upstream PKCE and saves the Codex account", async () => {
  const accessToken = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({
    email: "codex@example.test",
    "https://api.openai.com/auth": { chatgpt_account_id: "workspace-a", chatgpt_plan_type: "plus" },
  })).toString("base64url")}.signature`;
  const fetch = vi.fn()
    .mockResolvedValueOnce(Response.json({
      device_auth_id: "device-auth-id", usercode: "ABCD-1234", interval: " 5 ",
    }))
    .mockResolvedValueOnce(new Response(null, { status: 403 }))
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(Response.json({
      authorization_code: "approved-code", code_challenge: "challenge", code_verifier: "upstream-verifier",
    }))
    .mockResolvedValueOnce(Response.json({
      access_token: accessToken, refresh_token: "refresh-token", expires_in: 3600,
    }));
  vi.stubGlobal("fetch", fetch);
  createConnection.mockResolvedValue({ id: "saved-account", provider: "codex" });

  const response = await requestCode();
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    device_code: "device-auth-id", user_code: "ABCD-1234",
    verification_uri: "https://auth.openai.com/codex/device", interval: 5, expires_in: 900,
  });
  expect(fetch.mock.calls[0][0]).toBe("https://auth.openai.com/api/accounts/deviceauth/usercode");
  const startBody = JSON.parse(fetch.mock.calls[0][1].body);
  expect(startBody.client_id).toEqual(expect.any(String));

  for (const _status of [403, 404]) {
    expect(await (await poll()).json()).toMatchObject({ success: false, pending: true });
    expect(createConnection).not.toHaveBeenCalled();
  }
  expect(fetch.mock.calls[1][0]).toBe("https://auth.openai.com/api/accounts/deviceauth/token");
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
    device_auth_id: "device-auth-id", user_code: "ABCD-1234",
  });

  expect(await (await poll()).json()).toEqual({
    success: true, connection: { id: "saved-account", provider: "codex" },
  });
  expect(fetch.mock.calls[4][0]).toBe("https://auth.openai.com/oauth/token");
  expect(Object.fromEntries(fetch.mock.calls[4][1].body)).toEqual({
    client_id: startBody.client_id,
    grant_type: "authorization_code",
    code: "approved-code",
    code_verifier: "upstream-verifier",
    redirect_uri: "https://auth.openai.com/deviceauth/callback",
  });
  expect(createConnection).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    provider: "codex", authType: "oauth", email: "codex@example.test",
    accessToken, refreshToken: "refresh-token", expiresAt: expect.any(String),
    providerSpecificData: { chatgptAccountId: "workspace-a", chatgptPlanType: "plus" },
  }));
});

it("rejects a poll without a user code before contacting the provider", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  expect((await poll({})).status).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
  expect(createConnection).not.toHaveBeenCalled();
});

it("returns a terminal error if the provider fails", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
  const response = await poll();
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "Codex device authorization failed (HTTP 500)" });
  expect(createConnection).not.toHaveBeenCalled();
});
