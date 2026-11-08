import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI_TOKEN = "0123456789abcdef";

const mocks = vi.hoisted(() => ({
  exportDb: vi.fn(async () => ({ settings: { password: "hash" } })),
  importDb: vi.fn(),
  verifyDashboardPassword: vi.fn(async () => false),
  getProviderConnections: vi.fn(),
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: vi.fn(async () => CLI_TOKEN),
}));

vi.mock("@/lib/localDb", () => ({
  exportDb: mocks.exportDb,
  importDb: mocks.importDb,
  getSettings: vi.fn(async () => ({})),
  getProviderConnections: mocks.getProviderConnections,
}));

vi.mock("@/lib/network/outboundProxy", () => ({ applyOutboundProxyEnv: vi.fn() }));

vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardPassword: mocks.verifyDashboardPassword,
}));

vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: vi.fn(async (model) => ({ provider: "openai", model })),
}));

describe("DB export/import password step-up", () => {
  let route;
  beforeEach(async () => {
    vi.clearAllMocks();
    route = await import("../../src/app/api/settings/database/route.js");
  });

  const get = (headers) => route.GET(new Request("http://localhost/api/settings/database", { headers }));

  it("does not let an arbitrary x-9r-cli-token value skip the password", async () => {
    const res = await get({ "x-9r-cli-token": "anything" });
    expect(res.status).toBe(401);
    expect(mocks.exportDb).not.toHaveBeenCalled();
  });

  it("rejects an import with a wrong CLI token and no password", async () => {
    const res = await route.POST(
      new Request("http://localhost/api/settings/database", {
        method: "POST",
        headers: { "x-9r-cli-token": "x".repeat(CLI_TOKEN.length) },
        body: JSON.stringify({ settings: {} }),
      })
    );
    expect(res.status).toBe(401);
    expect(mocks.importDb).not.toHaveBeenCalled();
  });

  it("accepts the real CLI token", async () => {
    const res = await get({ "x-9r-cli-token": CLI_TOKEN });
    expect(res.status).toBe(200);
  });

  it("still accepts the dashboard password", async () => {
    mocks.verifyDashboardPassword.mockResolvedValueOnce(true);
    const res = await get({ "x-9r-password": "pw" });
    expect(res.status).toBe(200);
  });
});

describe("cowork status does not disclose the CLI token", () => {
  const originalHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "10r-cowork-"));

  afterAll(() => {
    process.env.HOME = originalHome;
  });

  it("strips bridge headers and the gateway key from GET /api/cli-tools/cowork-settings", async () => {
    process.env.HOME = home;
    const libDir = path.join(home, ".config", "Claude-3p", "configLibrary");
    fs.mkdirSync(libDir, { recursive: true });
    fs.writeFileSync(path.join(libDir, "_meta.json"), JSON.stringify({ appliedId: "cfg" }));
    fs.writeFileSync(
      path.join(libDir, "cfg.json"),
      JSON.stringify({
        inferenceProvider: "gateway",
        inferenceGatewayBaseUrl: "http://localhost:20128/v1",
        inferenceGatewayApiKey: "sk-client-key-secret",
        inferenceModels: ["m"],
        managedMcpServers: [
          {
            name: "files",
            url: "http://localhost:20128/api/mcp/files",
            transport: "http",
            headers: { "x-9r-cli-token": CLI_TOKEN },
          },
        ],
      })
    );

    const { GET } = await import("../../src/app/api/cli-tools/cowork-settings/route.js");
    const res = await GET();
    const text = JSON.stringify(await res.json());

    expect(text).not.toContain(CLI_TOKEN);
    expect(text).not.toContain("sk-client-key-secret");
    expect(text).toContain("http://localhost:20128/api/mcp/files");
  });
});

describe("translator preview step 3", () => {
  const SECRET = "sk-provider-live-secret-0001";

  it("returns header names but never the provider credential", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { isActive: true, apiKey: SECRET, accessToken: "oauth-access-token-0001" },
    ]);
    const { POST } = await import("../../src/app/api/translator/translate/route.js");
    const res = await POST(
      new Request("http://localhost/api/translator/translate", {
        method: "POST",
        body: JSON.stringify({
          step: 3,
          body: {
            provider: "openai",
            model: "gpt-4o-mini",
            body: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] },
          },
        }),
      })
    );
    const json = await res.json();
    const text = JSON.stringify(json);

    expect(json.error).toBeUndefined();
    expect(json.success).toBe(true);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("oauth-access-token-0001");
    const headerNames = Object.keys(json.result.headers).map((h) => h.toLowerCase());
    expect(headerNames).toContain("authorization");
  });
});
