import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractCodexAccountInfo } from "../../src/lib/oauth/providerHelpers.js";
import codex from "../../src/lib/oauth/providers/codex.js";
import { POST as bulkImport } from "../../src/app/api/oauth/codex/bulk-import/route.js";
import { POST as importToken } from "../../src/app/api/oauth/codex/import-token/route.js";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@/models", () => ({ createProviderConnection: create }));
vi.mock("@/lib/oauth/providers", async () => import("../../src/lib/oauth/providerHelpers.js"));
vi.mock("next/server", () => ({ NextResponse: { json: (body, init) => Response.json(body, init) } }));

const jwt = (claims) => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
const request = (body) => new Request("http://localhost/api/oauth/codex/import", {
  method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
});
const accessToken = jwt({
  "https://api.openai.com/profile": { email: "owner@example.com" },
  "https://api.openai.com/auth": { chatgpt_account_id: "workspace-a", chatgpt_plan_type: "team" },
});

beforeEach(() => {
  create.mockReset().mockImplementation(async (data) => ({ id: "connection-a", ...data }));
});

describe("Codex identity across credential entry points", () => {
  it("reads the namespaced profile email with workspace claims", () => {
    expect(extractCodexAccountInfo(accessToken)).toEqual({
      email: "owner@example.com", chatgptAccountId: "workspace-a", chatgptPlanType: "team",
    });
  });

  it("fills missing ID-token claims from the access token during OAuth mapping", () => {
    const mapped = codex.mapTokens({ id_token: jwt({ email: "owner@example.com" }), access_token: accessToken });
    expect(mapped.email).toBe("owner@example.com");
    expect(mapped.providerSpecificData).toEqual({ chatgptAccountId: "workspace-a", chatgptPlanType: "team" });
  });

  it("keeps ID-token claims authoritative when both tokens carry identity", () => {
    expect(extractCodexAccountInfo(jwt({ email: "id@example.com", account_id: "workspace-id", plan_type: "plus" }), accessToken))
      .toEqual({ email: "id@example.com", chatgptAccountId: "workspace-id", chatgptPlanType: "plus" });
  });

  it("persists workspace identity in bulk imports with a partial ID token", async () => {
    const res = await bulkImport(request({ idToken: jwt({ email: "owner@example.com" }), accessToken }));
    expect(await res.json()).toMatchObject({ success: 1, failed: 0 });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      email: "owner@example.com", providerSpecificData: { chatgptAccountId: "workspace-a", chatgptPlanType: "team" },
    }));
  });

  it("persists top-level ChatGPT workspace claims even when email is present", async () => {
    const token = jwt({ email: "owner@example.com", account_id: "workspace-web", plan_type: "plus", exp: 2000000000 });
    const res = await importToken(request({ accessToken: token }));
    expect(await res.json()).toMatchObject({ connection: { email: "owner@example.com", workspace: "workspace-web", plan: "plus" } });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ providerSpecificData: {
      authMethod: "access_token", chatgptAccountId: "workspace-web", chatgptPlanType: "plus", jwtExp: 2000000000,
    } }));
  });

  it("rejects blank credentials in both import routes without persisting them", async () => {
    expect((await importToken(request({ accessToken: "   " }))).status).toBe(400);
    expect(await (await bulkImport(request({ accessToken: "   " }))).json()).toMatchObject({ success: 0, failed: 1 });
    expect(create).not.toHaveBeenCalled();
  });

  it("allows opaque credentials without inventing JWT identity", async () => {
    expect(extractCodexAccountInfo("opaque")).toEqual({});
    const res = await importToken(request({ accessToken: "opaque" }));
    expect(res.status).toBe(200);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ accessToken: "opaque", email: null }));
  });
});
