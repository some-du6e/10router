import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractCodexAccountInfo, codexAccessTokenFields } from "../../src/lib/oauth/providerHelpers.js";
import codex from "../../src/lib/oauth/providers/codex.js";
import { backfillCodexEmails } from "../../src/lib/oauth/providers/index.js";
import { POST as bulkImport } from "../../src/app/api/oauth/codex/bulk-import/route.js";
import { POST as importToken } from "../../src/app/api/oauth/codex/import-token/route.js";
import { POST as oauthAction } from "../../src/app/api/oauth/[provider]/[action]/route.js";

const { create, exchangeTokens, listConnections, updateConnection } = vi.hoisted(() => ({
  create: vi.fn(), exchangeTokens: vi.fn(), listConnections: vi.fn(), updateConnection: vi.fn(),
}));
vi.mock("@/models", () => ({ createProviderConnection: create }));
vi.mock("@/lib/oauth/providers", () => ({ exchangeTokens }));
vi.mock("@/lib/oauth/utils/server", () => ({}));
vi.mock("@/lib/oauth/utils/ideDetect", () => ({ detectIdeInstalled: vi.fn() }));
vi.mock("@/lib/localDb", () => ({ getProviderConnections: listConnections, updateProviderConnection: updateConnection }));
vi.mock("next/server", () => ({ NextResponse: { json: (body, init) => Response.json(body, init) } }));

const jwt = (claims) => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
const request = (body) => new Request("http://localhost/api/oauth/codex/import", {
  method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
});
const AUTH = "https://api.openai.com/auth";
const PROFILE = "https://api.openai.com/profile";
const accessToken = jwt({
  sub: "user-a",
  [PROFILE]: { email: "owner@example.com" },
  [AUTH]: { chatgpt_account_id: "workspace-a", chatgpt_plan_type: "team" },
});
const identity = (info) => ({ email: info.email, chatgptAccountId: info.chatgptAccountId, chatgptPlanType: info.chatgptPlanType });

beforeEach(() => {
  vi.clearAllMocks();
  create.mockImplementation(async (data) => ({ id: "connection-a", ...data }));
});

describe("Codex claims", () => {
  it.each([
    ["the namespaced profile email", { [PROFILE]: { email: "p@example.com" } }, { email: "p@example.com" }],
    ["the top-level email ahead of the profile email", { email: "top@example.com", [PROFILE]: { email: "p@example.com" } }, { email: "top@example.com" }],
    ["preferred_username when there is no email", { preferred_username: "handle" }, { email: "handle" }],
    ["top-level account_id and plan_type", { account_id: "ws-top", plan_type: "plus" }, { chatgptAccountId: "ws-top", chatgptPlanType: "plus" }],
    ["namespaced workspace claims ahead of top-level ones",
      { account_id: "ws-top", plan_type: "plus", [AUTH]: { chatgpt_account_id: "ws-ns", chatgpt_plan_type: "team" } },
      { chatgptAccountId: "ws-ns", chatgptPlanType: "team" }],
    ["only string claim values", { email: 7, account_id: { id: "x" }, plan_type: ["team"], preferred_username: "handle" }, { email: "handle" }],
  ])("reads %s from an access token alone", (_label, claims, expected) => {
    expect(identity(extractCodexAccountInfo(null, jwt(claims)))).toEqual({
      email: undefined, chatgptAccountId: undefined, chatgptPlanType: undefined, ...expected,
    });
  });

  it("keeps ID-token claims ahead of the same user's access token", () => {
    const idToken = jwt({ sub: "user-a", email: "id@example.com", account_id: "workspace-id", plan_type: "plus" });
    expect(identity(extractCodexAccountInfo(idToken, accessToken)))
      .toEqual({ email: "id@example.com", chatgptAccountId: "workspace-id", chatgptPlanType: "plus" });
  });

  it("puts any email ahead of preferred_username, whichever token it is in", () => {
    const idToken = jwt({ sub: "user-a", preferred_username: "handle" });
    expect(extractCodexAccountInfo(idToken, accessToken).email).toBe("owner@example.com");
  });

  it("fills gaps from the access token only when both tokens name the same subject", () => {
    const staleIdToken = jwt({ sub: "user-a", email: "a@example.com" });
    const otherUser = jwt({ sub: "user-b", [AUTH]: { chatgpt_account_id: "workspace-b", chatgpt_plan_type: "team" } });
    expect(identity(extractCodexAccountInfo(staleIdToken, otherUser)))
      .toEqual({ email: "a@example.com", chatgptAccountId: undefined, chatgptPlanType: undefined });
    expect(extractCodexAccountInfo(jwt({ email: "a@example.com" }), otherUser).chatgptAccountId).toBeUndefined();
  });

  it("falls back to the access token when the ID token won't decode", () => {
    expect(identity(extractCodexAccountInfo("not-a-jwt", accessToken)))
      .toEqual({ email: "owner@example.com", chatgptAccountId: "workspace-a", chatgptPlanType: "team" });
  });

  it("reads nothing from opaque credentials", () => {
    expect(identity(extractCodexAccountInfo("opaque", "opaque")))
      .toEqual({ email: undefined, chatgptAccountId: undefined, chatgptPlanType: undefined });
  });

  it("builds access-token connection fields with the JWT expiry", () => {
    expect(codexAccessTokenFields(jwt({ email: "o@example.com", account_id: "ws", exp: 2000000000 }))).toEqual({
      email: "o@example.com", providerSpecificData: { authMethod: "access_token", chatgptAccountId: "ws", jwtExp: 2000000000 },
    });
  });
});

describe("Codex OAuth mapping", () => {
  it("fills missing ID-token claims from the same user's access token", () => {
    const mapped = codex.mapTokens({ id_token: jwt({ sub: "user-a", email: "owner@example.com" }), access_token: accessToken });
    expect(mapped.email).toBe("owner@example.com");
    expect(mapped.providerSpecificData).toEqual({ chatgptAccountId: "workspace-a", chatgptPlanType: "team" });
  });

  it("uses the subject as the email when no token has an email claim", () => {
    const mapped = codex.mapTokens({ id_token: jwt({ sub: "user-sub-only" }), access_token: jwt({ sub: "user-sub-only" }) });
    expect(mapped.email).toBe("user-sub-only");
  });
});

describe("Codex imports", () => {
  it("saves workspace identity in bulk imports with a partial ID token", async () => {
    const res = await bulkImport(request({ idToken: jwt({ sub: "user-a", email: "owner@example.com" }), accessToken }));
    expect(await res.json()).toMatchObject({ success: 1, failed: 0 });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      email: "owner@example.com", providerSpecificData: { chatgptAccountId: "workspace-a", chatgptPlanType: "team" },
    }));
  });

  it("fills identity from the access token when a bulk item has no ID token", async () => {
    await bulkImport(request({ accessToken }));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      email: "owner@example.com", providerSpecificData: { chatgptAccountId: "workspace-a", chatgptPlanType: "team" },
    }));
  });

  it("trims the tokens a bulk import saves", async () => {
    await bulkImport(request({ accessToken: `  ${accessToken}\n`, refreshToken: " refresh-a ", idToken: "   " }));
    const saved = create.mock.calls[0][0];
    expect(saved).toMatchObject({ accessToken, refreshToken: "refresh-a" });
    expect(saved.idToken).toBeUndefined();
  });

  it("saves top-level ChatGPT workspace claims from a pasted access token even when email is present", async () => {
    const token = jwt({ email: "owner@example.com", account_id: "workspace-web", plan_type: "plus", exp: 2000000000 });
    const res = await importToken(request({ accessToken: token }));
    expect(await res.json()).toMatchObject({ connection: { email: "owner@example.com", workspace: "workspace-web", plan: "plus" } });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ providerSpecificData: {
      authMethod: "access_token", chatgptAccountId: "workspace-web", chatgptPlanType: "plus", jwtExp: 2000000000,
    } }));
  });

  it("refuses empty or whitespace-only credentials in both import routes without saving them", async () => {
    expect((await importToken(request({ accessToken: "   " }))).status).toBe(400);
    expect(await (await bulkImport(request({ accessToken: "   " }))).json()).toMatchObject({ success: 0, failed: 1 });
    expect(create).not.toHaveBeenCalled();
  });

  it("allows opaque credentials without inventing JWT identity", async () => {
    const res = await importToken(request({ accessToken: "opaque" }));
    expect(res.status).toBe(200);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ accessToken: "opaque", email: null }));
  });
});

describe("raw JWT pasted into the OAuth exchange", () => {
  const exchange = (provider, code) => oauthAction(
    request({ code, redirectUri: "http://localhost/callback", codeVerifier: "verifier", state: "state" }),
    { params: Promise.resolve({ provider, action: "exchange" }) },
  );

  it("saves a trimmed Codex access token with its identity and expiry", async () => {
    const token = jwt({ ...JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url")), exp: 2000000000 });
    const res = await exchange("codex", `  ${token}\n`);
    expect(res.status).toBe(200);
    expect(exchangeTokens).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      provider: "codex", authType: "access_token", accessToken: token, email: "owner@example.com",
      providerSpecificData: { authMethod: "access_token", chatgptAccountId: "workspace-a", chatgptPlanType: "team", jwtExp: 2000000000 },
    }));
  });

  it("sends another provider's JWT-shaped code through the normal exchange", async () => {
    exchangeTokens.mockResolvedValue({ accessToken: "exchanged" });
    await exchange("cline", accessToken);
    expect(exchangeTokens).toHaveBeenCalledWith("cline", accessToken, "http://localhost/callback", "verifier", "state", undefined);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ provider: "cline", authType: "oauth", accessToken: "exchanged" }));
  });
});

describe("Codex identity backfill", () => {
  it("reads both tokens and skips only rows that have neither", async () => {
    listConnections.mockResolvedValue([
      { id: "access-only", provider: "codex", authType: "oauth", accessToken },
      { id: "no-tokens", provider: "codex", authType: "oauth" },
      { id: "stale-id", provider: "codex", authType: "oauth", idToken: jwt({ sub: "user-b", email: "b@example.com" }), accessToken },
    ]);
    await backfillCodexEmails();
    expect(updateConnection).toHaveBeenCalledTimes(2);
    expect(updateConnection).toHaveBeenCalledWith("access-only", {
      email: "owner@example.com", providerSpecificData: { chatgptAccountId: "workspace-a", chatgptPlanType: "team" },
    });
    expect(updateConnection).toHaveBeenCalledWith("stale-id", { email: "b@example.com" });
  });
});
