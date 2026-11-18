// updateProviderConnection's refreshTokenUsed option, against the real SQLite repo:
// a connection test's refresh lands only on the row that still holds the refresh
// token it used, so a login that replaced the tokens meanwhile is kept.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-refresh-cas-"));
process.env.DATA_DIR = tempDir;

let db;
beforeAll(async () => {
  db = await import("@/lib/db/index.js");
});
afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const addOAuth = () => db.createProviderConnection({
  provider: "codex", authType: "oauth", email: `user-${Math.random()}@example.com`,
  accessToken: "access-1", refreshToken: "refresh-1",
});

describe("refreshTokenUsed", () => {
  it("writes while the row still holds that refresh token", async () => {
    const conn = await addOAuth();
    const saved = await db.updateProviderConnection(conn.id, { accessToken: "access-2", refreshToken: "refresh-2" },
      { refreshTokenUsed: "refresh-1" });
    expect(saved).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2" });
    expect(await db.getProviderConnectionById(conn.id)).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2" });
  });

  it("writes nothing and returns null once another login replaced it", async () => {
    const conn = await addOAuth();
    await db.updateProviderConnection(conn.id, { accessToken: "relogin-access", refreshToken: "relogin-refresh" });
    const saved = await db.updateProviderConnection(conn.id, { accessToken: "access-2", refreshToken: "refresh-2", testStatus: "error" },
      { refreshTokenUsed: "refresh-1" });
    expect(saved).toBeNull();
    const row = await db.getProviderConnectionById(conn.id);
    expect(row).toMatchObject({ accessToken: "relogin-access", refreshToken: "relogin-refresh" });
    expect(row.testStatus).not.toBe("error");
  });

  it("leaves updates without the option unconditional", async () => {
    const conn = await addOAuth();
    expect(await db.updateProviderConnection(conn.id, { testStatus: "active" })).toMatchObject({ testStatus: "active" });
  });
});
