import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10r-provider-secrets-"));
const originalDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = tempDir;

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), { status: init.status || 200, headers: { "Content-Type": "application/json" } });
    },
  },
}));

const listRoute = await import("@/app/api/providers/route.js");
const itemRoute = await import("@/app/api/providers/[id]/route.js");
const { createProviderConnection, getProviderConnectionById } = await import("@/models/index.js");

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const SECRETS = {
  copilotToken: "copilot-bearer-placeholder-0001",
  clientSecret: "kiro-idc-client-secret-placeholder",
  firebaseIdToken: "firebase-id-token-placeholder-0001",
};
const KEPT = { region: "us-east-1", profileArn: "arn:aws:codewhisperer:us-east-1:000000000000:profile/PLACEHOLDER", maxCompletionTokens: 4096 };

const connection = await createProviderConnection({
  provider: "kiro",
  authType: "oauth",
  name: "placeholder account",
  accessToken: "access-token-placeholder-0001",
  refreshToken: "refresh-token-placeholder-0001",
  providerSpecificData: { ...SECRETS, ...KEPT },
});

function expectNoSecrets(json) {
  const text = JSON.stringify(json);
  for (const value of [...Object.values(SECRETS), "access-token-placeholder-0001", "refresh-token-placeholder-0001"]) {
    expect(text).not.toContain(value);
  }
}

describe("provider connection responses", () => {
  it("GET /api/providers leaves the secrets in providerSpecificData out and keeps the rest", async () => {
    const json = await (await listRoute.GET(new Request("http://localhost/api/providers"))).json();
    expectNoSecrets(json);
    const listed = json.connections.find((c) => c.id === connection.id);
    expect(listed.providerSpecificData).toMatchObject(KEPT);
  });

  it("GET /api/providers/[id] does the same", async () => {
    const json = await (await itemRoute.GET(new Request("http://localhost/x"), { params: Promise.resolve({ id: connection.id }) })).json();
    expectNoSecrets(json);
    expect(json.connection.providerSpecificData).toMatchObject(KEPT);
  });

  it("an update that sends providerSpecificData back keeps the stored secrets", async () => {
    const got = await (await itemRoute.GET(new Request("http://localhost/x"), { params: Promise.resolve({ id: connection.id }) })).json();
    const res = await itemRoute.PUT(
      new Request("http://localhost/x", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "renamed", providerSpecificData: got.connection.providerSpecificData }),
      }),
      { params: Promise.resolve({ id: connection.id }) }
    );
    expect(res.status).toBe(200);
    expectNoSecrets(await res.json());
    const stored = await getProviderConnectionById(connection.id);
    expect(stored.providerSpecificData).toMatchObject({ ...SECRETS, ...KEPT });
    expect(stored.name).toBe("renamed");
  });
});
