import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const state = vi.hoisted(() => ({ dataDir: "" }));

vi.mock("@/lib/dataDir.js", () => ({
  get DATA_DIR() {
    return state.dataDir;
  },
}));

const isPosix = process.platform !== "win32";
const mode = (p) => fs.statSync(p).mode & 0o777;

describe("client API key generation", () => {
  it("draws the secret part from the CSPRNG with at least 128 bits", async () => {
    const random = vi.spyOn(Math, "random");
    const { generateApiKeyWithMachine, parseApiKey } = await import("../../src/shared/utils/apiKey.js");
    const seen = new Set();
    for (let i = 0; i < 200; i++) {
      const { key, keyId } = generateApiKeyWithMachine("abcdef0123456789");
      expect(keyId).toMatch(/^[a-z2-7]{26}$/);
      expect(parseApiKey(key)).toEqual({ machineId: "abcdef0123456789", keyId, isNewFormat: true });
      seen.add(keyId);
    }
    expect(seen.size).toBe(200);
    expect(random).not.toHaveBeenCalled();
    random.mockRestore();
  });
});

describe("request log header masking", () => {
  it("masks credential headers and keeps the rest", async () => {
    const { maskSensitiveHeaders } = await import("../../open-sse/utils/requestLogger.js");
    const masked = maskSensitiveHeaders({
      Authorization: "Bearer sk-abcdefghijklmnopqrstuvwxyz",
      "x-api-key": "sk-ant-api03-secretsecretsecret",
      "x-9r-cli-token": "0123456789abcdef",
      Cookie: "auth_token=eyJhbGciOi.secret",
      "content-type": "application/json",
    });
    const text = JSON.stringify(masked);
    expect(text).not.toContain("sk-abcdefghijklmnop");
    expect(text).not.toContain("secretsecret");
    expect(text).not.toContain("0123456789abcdef");
    expect(text).not.toContain("eyJhbGciOi");
    expect(masked["content-type"]).toBe("application/json");
    expect(masked.Authorization).toBe("***wxyz");
  });

  it.runIf(isPosix)("writes log files only the owner can read", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "10r-logs-"));
    vi.resetModules();
    process.env.ENABLE_REQUEST_LOGS = "true";
    const spy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
    try {
      const { createRequestLogger } = await import("../../open-sse/utils/requestLogger.js");
      const logger = await createRequestLogger("openai", "openai", "m");
      logger.logClientRawRequest("/v1/chat/completions", { a: 1 }, { authorization: "Bearer sk-1234567890abcdefghij" });
      const file = path.join(logger.sessionPath, fs.readdirSync(logger.sessionPath)[0]);
      expect(mode(logger.sessionPath)).toBe(0o700);
      expect(mode(file)).toBe(0o600);
      expect(fs.readFileSync(file, "utf8")).not.toContain("sk-1234567890abcdef");
    } finally {
      spy.mockRestore();
      delete process.env.ENABLE_REQUEST_LOGS;
    }
  });
});

describe.runIf(isPosix)("SQLite credential store permissions", () => {
  let umask;
  beforeEach(() => {
    umask = process.umask(0o022);
    state.dataDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "10r-db-")), "data");
    vi.resetModules();
  });
  afterEach(() => process.umask(umask));

  it("creates the data and db directories 0700", async () => {
    const { ensureDirs, DB_DIR, BACKUPS_DIR } = await import("../../src/lib/db/paths.js");
    ensureDirs();
    expect(mode(state.dataDir)).toBe(0o700);
    expect(mode(DB_DIR)).toBe(0o700);
    expect(mode(BACKUPS_DIR)).toBe(0o700);
  });

  it("tightens an existing world-readable db directory and database files", async () => {
    const { ensureDirs, restrictDbFilePermissions, DB_DIR, DATA_FILE } = await import("../../src/lib/db/paths.js");
    fs.mkdirSync(DB_DIR, { recursive: true, mode: 0o755 });
    for (const f of [DATA_FILE, `${DATA_FILE}-wal`]) fs.writeFileSync(f, "x", { mode: 0o644 });

    ensureDirs();
    restrictDbFilePermissions();

    expect(mode(DB_DIR)).toBe(0o700);
    expect(mode(DATA_FILE)).toBe(0o600);
    expect(mode(`${DATA_FILE}-wal`)).toBe(0o600);
  });
});
