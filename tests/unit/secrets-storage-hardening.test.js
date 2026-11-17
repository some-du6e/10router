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
      expect(keyId).toMatch(/^[0-9a-f]{32}$/);
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
    const { maskSensitiveHeaders } = await import("../../open-sse/utils/redact.js");
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

  it.runIf(isPosix)("writes log files, streamed chunks included, only the owner can read", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "10r-logs-"));
    const umask = process.umask(0o022);
    vi.resetModules();
    process.env.ENABLE_REQUEST_LOGS = "true";
    const spy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
    try {
      const { createRequestLogger } = await import("../../open-sse/utils/requestLogger.js");
      const logger = await createRequestLogger("openai", "openai", "m");
      logger.logClientRawRequest("/v1/chat/completions", { a: 1 }, { authorization: "Bearer sk-1234567890abcdefghij" });
      logger.appendProviderChunk("data: {}\n\n");
      logger.appendOpenAIChunk("data: {}\n\n");
      logger.appendConvertedChunk("data: {}\n\n");
      const files = fs.readdirSync(logger.sessionPath);
      expect(files.sort()).toEqual(["1_req_client.json", "5_res_provider.txt", "6_res_openai.txt", "7_res_client.txt"]);
      expect(mode(logger.sessionPath)).toBe(0o700);
      for (const name of files) expect(mode(path.join(logger.sessionPath, name))).toBe(0o600);
      expect(fs.readFileSync(path.join(logger.sessionPath, "1_req_client.json"), "utf8")).not.toContain("sk-1234567890abcdef");
    } finally {
      spy.mockRestore();
      process.umask(umask);
      delete process.env.ENABLE_REQUEST_LOGS;
    }
  });

  it("redacts every secret query param in the target request the chat handler logs", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "10r-target-"));
    vi.resetModules();
    process.env.ENABLE_REQUEST_LOGS = "true";
    const spy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
    try {
      const { createRequestLogger } = await import("../../open-sse/utils/requestLogger.js");
      const logger = await createRequestLogger("openai", "gemini", "m");
      const { SECRET_QUERY_PARAMS } = await import("../../open-sse/utils/redact.js");
      const titleCase = (p) => p.replace(/(^|[_-])([a-z])/g, (_m, sep, c) => sep + c.toUpperCase());
      const params = SECRET_QUERY_PARAMS.flatMap((p) => [p, p.toUpperCase(), titleCase(p)]);
      const url = "https://upstream.example/v1/models/m:generateContent?alt=sse&" + params.map((p, i) => `${p}=SECRETVALUE${i}`).join("&");
      logger.logTargetRequest(url, { "x-goog-api-key": "SECRETHEADERVALUE123" }, {});
      const text = fs.readFileSync(path.join(logger.sessionPath, "4_req_target.json"), "utf8");
      expect(text).not.toMatch(/SECRETVALUE\d/);
      expect(text).not.toContain("SECRETHEADERVALUE");
      expect(text).toContain("alt=sse");
    } finally {
      spy.mockRestore();
      delete process.env.ENABLE_REQUEST_LOGS;
    }
  });
});

describe("request log URL redaction", () => {
  it("redacts credentials carried in the query string", async () => {
    const { redactUrlSecrets } = await import("../../open-sse/utils/redact.js");
    const url = redactUrlSecrets("https://aiplatform.example/v1/models/m:streamGenerateContent?alt=sse&key=AIzaSecretValue");
    expect(url).not.toContain("AIzaSecretValue");
    expect(url).toContain("alt=sse");
    expect(redactUrlSecrets("https://api.example/v1/chat")).toBe("https://api.example/v1/chat");
  });

  it.runIf(isPosix)("writes error logs owner-only and tightens an existing logs dir", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "10r-errlogs-"));
    fs.mkdirSync(path.join(cwd, "logs"), { mode: 0o755 });
    vi.resetModules();
    process.env.ENABLE_REQUEST_LOGS = "true";
    const spy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
    try {
      const { logError, createRequestLogger } = await import("../../open-sse/utils/requestLogger.js");
      await createRequestLogger("openai", "openai", "m");
      logError("vertex", { error: new Error("boom"), url: "https://v.example/x?key=AIzaSecretValue", model: "m" });
      const logsDir = path.join(cwd, "logs");
      const file = path.join(logsDir, fs.readdirSync(logsDir).find((f) => f.endsWith(".log")));
      expect(mode(logsDir)).toBe(0o700);
      expect(mode(file)).toBe(0o600);
      expect(fs.readFileSync(file, "utf8")).not.toContain("AIzaSecretValue");
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
