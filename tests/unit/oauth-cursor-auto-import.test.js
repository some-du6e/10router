import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fsPromises from "fs/promises";
import { execFile } from "child_process";

const validToken = "a".repeat(64);
const alternateToken = "b".repeat(64);
const validMachineId = "a".repeat(32);
const alternateMachineId = "b".repeat(32);

vi.mock("child_process", () => {
  const execFile = vi.fn((_file, _args, _options, callback) => callback(new Error("ENOENT")));
  // Node's execFile custom promisifier collects both callback output strings.
  execFile[Symbol.for("nodejs.util.promisify.custom")] = (...args) => new Promise((resolve, reject) => {
    execFile(...args, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
  return { execFile };
});

// Mock next/server
vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
    })),
  },
}));

// Mock os
vi.mock("os", () => ({
  default: { homedir: vi.fn(() => "/mock/home") },
  homedir: vi.fn(() => "/mock/home"),
}));

// Mock fs/promises
vi.mock("fs/promises", () => ({
  access: vi.fn(),
  constants: { R_OK: 4 },
}));

// Shared mock db instance
const mockDbInstance = {
  prepare: vi.fn(),
  close: vi.fn(),
  __throwOnConstruct: false,
  __constructError: null,
};

// Mock better-sqlite3 as a class so `new Database(...)` works
vi.mock("better-sqlite3", () => ({
  default: class MockDatabase {
    constructor() {
      if (mockDbInstance.__constructError) throw mockDbInstance.__constructError;
      if (mockDbInstance.__throwOnConstruct) {
        throw new Error("SQLITE_CANTOPEN");
      }
      return mockDbInstance;
    }
  },
}));

// We need to dynamically import after mocks are registered
let GET;

describe("GET /api/oauth/cursor/auto-import", () => {
  const originalPlatform = process.platform;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockDbInstance.prepare.mockReset();
    vi.mocked(execFile).mockImplementation((_file, _args, _options, callback) => callback(new Error("ENOENT")));
    mockDbInstance.__throwOnConstruct = false;
    mockDbInstance.__constructError = null;
    // Force darwin so macOS-specific logic is exercised
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    // Re-import to pick up fresh mocks each run
    const mod = await import("../../src/app/api/oauth/cursor/auto-import/route.js");
    GET = mod.GET;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  });

  // ── macOS path probing ────────────────────────────────────────────────

  it("returns not-found when no macOS cursor db paths are accessible", async () => {
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain("Cursor database not found in known macOS locations");
  });

  it("returns descriptive error if macOS db file exists but cannot be opened", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    mockDbInstance.__throwOnConstruct = true;

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain("could not be opened");
    expect(response.body.error).toContain("SQLITE_CANTOPEN");
  });

  // ── Token extraction ──────────────────────────────────────────────────

  it("extracts tokens using exact keys", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    mockDbInstance.prepare.mockReturnValue({
      all: vi.fn().mockReturnValue([
        { key: "cursorAuth/accessToken", value: validToken },
        { key: "storage.serviceMachineId", value: validMachineId },
      ]),
    });

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe(validToken);
    expect(response.body.machineId).toBe(validMachineId);
    expect(mockDbInstance.close).toHaveBeenCalled();
  });

  it("unwraps JSON-encoded string values", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    mockDbInstance.prepare.mockReturnValue({
      all: vi.fn().mockReturnValue([
        { key: "cursorAuth/accessToken", value: JSON.stringify(validToken) },
        { key: "storage.serviceMachineId", value: JSON.stringify(validMachineId) },
      ]),
    });

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe(validToken);
    expect(response.body.machineId).toBe(validMachineId);
  });

  it("selects exact credential keys in declared priority order regardless of row order", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    mockDbInstance.prepare.mockReturnValue({ all: vi.fn().mockReturnValue([
      { key: "cursorAuth/token", value: alternateToken },
      { key: "storage.machineId", value: alternateMachineId },
      { key: "telemetry.machineId", value: "c".repeat(32) },
      { key: "cursorAuth/accessToken", value: JSON.stringify(validToken) },
      { key: "storage.serviceMachineId", value: JSON.stringify(validMachineId) },
    ]) });
    const response = await GET();
    expect(response.body).toEqual({ found: true, accessToken: validToken, machineId: validMachineId });
    expect(mockDbInstance.close).toHaveBeenCalledOnce();
  });

  it.each([undefined, "null"])("prefers storage.machineId over telemetry when the service ID is %s", async (serviceId) => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    const rows = [
      { key: "telemetry.machineId", value: alternateMachineId },
      { key: "storage.machineId", value: validMachineId },
      { key: "cursorAuth/accessToken", value: validToken },
    ];
    if (serviceId !== undefined) rows.push({ key: "storage.serviceMachineId", value: serviceId });
    mockDbInstance.prepare.mockReturnValue({ all: vi.fn().mockReturnValue(rows) });

    expect((await GET()).body).toEqual({ found: true, accessToken: validToken, machineId: validMachineId });
  });

  it("keeps manual recovery available when both macOS database readers fail", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    mockDbInstance.__constructError = new Error("Native bindings unavailable");
    const response = await GET();
    expect(response.body.found).toBe(false);
    expect(response.body.windowsManual).toBe(true);
    expect(response.body.dbPath).toContain("state.vscdb");
    expect(response.body.error).toBeUndefined();
  });

  it.each(["null", "   ", '{"value":"not-a-credential"}', "invalid", JSON.stringify({ value: validToken })])("skips malformed preferred credentials: %s", async (invalid) => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    mockDbInstance.prepare.mockReturnValue({ all: vi.fn().mockReturnValue([
      { key: "cursorAuth/accessToken", value: invalid },
      { key: "storage.serviceMachineId", value: invalid },
      { key: "cursorAuth/token", value: validToken },
      { key: "storage.machineId", value: validMachineId },
    ]) });
    const response = await GET();
    expect(response.body).toEqual({ found: true, accessToken: validToken, machineId: validMachineId });
  });

  it.each([
    ["short token", "a".repeat(49), validMachineId, alternateToken, validMachineId],
    ["short machine ID", validToken, "a".repeat(31), validToken, alternateMachineId],
    ["nonhex machine ID", validToken, "z".repeat(32), validToken, alternateMachineId],
  ])("skips a preferred %s at the validation boundary", async (_label, token, machineId, expectedToken, expectedMachineId) => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    mockDbInstance.prepare.mockReturnValue({ all: vi.fn().mockReturnValue([
      { key: "cursorAuth/accessToken", value: token },
      { key: "storage.serviceMachineId", value: machineId },
      { key: "cursorAuth/token", value: alternateToken },
      { key: "storage.machineId", value: alternateMachineId },
    ]) });

    expect((await GET()).body).toEqual({
      found: true,
      accessToken: expectedToken,
      machineId: expectedMachineId,
    });
  });

  it("accepts credentials at the minimum valid lengths", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    const token = "a".repeat(50);
    mockDbInstance.prepare.mockReturnValue({ all: vi.fn().mockReturnValue([
      { key: "cursorAuth/accessToken", value: token },
      { key: "storage.serviceMachineId", value: validMachineId },
    ]) });

    expect((await GET()).body).toEqual({ found: true, accessToken: token, machineId: validMachineId });
  });

  it.each([false, true])("trims credential whitespace with JSON encoding %s", async (jsonEncoded) => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    const encode = (value) => jsonEncoded ? JSON.stringify(`  ${value}  `) : `  ${value}  `;
    mockDbInstance.prepare.mockReturnValue({ all: vi.fn().mockReturnValue([
      { key: "cursorAuth/accessToken", value: encode(validToken) },
      { key: "storage.serviceMachineId", value: encode(validMachineId) },
    ]) });

    expect((await GET()).body).toEqual({ found: true, accessToken: validToken, machineId: validMachineId });
  });

  it("reports missing login credentials after a successful empty CLI read", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    mockDbInstance.__constructError = new Error("Native bindings unavailable");
    vi.mocked(execFile).mockImplementation((_file, _args, _options, callback) => callback(null, "", ""));
    const response = await GET();
    expect(response.body.error).toContain("Please login to Cursor IDE first");
    expect(response.body.windowsManual).toBeUndefined();
    expect(execFile).toHaveBeenCalled();
  });

  it("reports missing login after CLI reads successfully despite native CANTOPEN", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    mockDbInstance.__throwOnConstruct = true;
    vi.mocked(execFile).mockImplementation((_file, _args, _options, callback) => callback(null, "", ""));

    const response = await GET();
    expect(response.body.found).toBe(false);
    expect(response.body.error).toBe("Please login to Cursor IDE first, then retry auto-import.");
    expect(response.body.windowsManual).toBeUndefined();
  });

  it("preserves numeric-only machine IDs stored as raw strings", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    const machineId = "1".repeat(32);
    mockDbInstance.prepare.mockReturnValue({ all: vi.fn().mockReturnValue([
      { key: "cursorAuth/accessToken", value: validToken },
      { key: "storage.serviceMachineId", value: machineId },
    ]) });
    const response = await GET();
    expect(response.body).toEqual({ found: true, accessToken: validToken, machineId });
  });

  it("uses valid CLI alternates when preferred keys are malformed", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    mockDbInstance.__constructError = new Error("Native bindings unavailable");
    vi.mocked(execFile).mockImplementation((_file, args, _options, callback) => {
      const sql = args[1];
      const value = sql.includes("'cursorAuth/token'") ? validToken
        : sql.includes("'storage.machineId'") ? validMachineId : "null";
      callback(null, value, "");
    });
    const response = await GET();
    expect(response.body).toEqual({ found: true, accessToken: validToken, machineId: validMachineId });
  });

  it("stops CLI queries at the first valid token and machine ID", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    mockDbInstance.__constructError = new Error("Native bindings unavailable");
    const values = new Map([
      ["cursorAuth/accessToken", validToken],
      ["cursorAuth/token", alternateToken],
      ["storage.serviceMachineId", validMachineId],
      ["storage.machineId", alternateMachineId],
      ["telemetry.machineId", "c".repeat(32)],
    ]);
    vi.mocked(execFile).mockImplementation((_file, args, _options, callback) => {
      const key = args[1].match(/WHERE key='([^']+)'/)[1];
      callback(null, `${values.get(key)}\n`, "sqlite warning");
    });

    expect((await GET()).body).toEqual({ found: true, accessToken: validToken, machineId: validMachineId });
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(execFile.mock.calls.map((call) => call[1][1])).toEqual([
      "SELECT value FROM itemTable WHERE key='cursorAuth/accessToken' LIMIT 1",
      "SELECT value FROM itemTable WHERE key='storage.serviceMachineId' LIMIT 1",
    ]);
  });

  // ── Fuzzy fallback (macOS only) ───────────────────────────────────────

  it("falls back to fuzzy key matching on macOS when exact keys are missing", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    mockDbInstance.prepare.mockImplementation((query) => {
      if (query.includes("IN (")) {
        return { all: vi.fn().mockReturnValue([]) };
      }
      // Fuzzy LIKE query
      return {
        all: vi.fn().mockReturnValue([
          { key: "cursorAuth/someOtherAccessTokenKey", value: validToken },
          { key: "storage.someMachineId", value: validMachineId },
        ]),
      };
    });

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe(validToken);
    expect(response.body.machineId).toBe(validMachineId);
  });

  it("skips malformed fuzzy credentials before valid fuzzy rows", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    mockDbInstance.prepare.mockImplementation((query) => ({ all: vi.fn().mockReturnValue(
      query.includes("IN (") ? [] : [
        { key: "cursorAuth/oldAccessToken", value: "a".repeat(49) },
        { key: "storage.oldMachineId", value: "z".repeat(32) },
        { key: "cursorAuth/currentAccessToken", value: validToken },
        { key: "storage.currentMachineId", value: validMachineId },
      ],
    ) }));

    expect((await GET()).body).toEqual({ found: true, accessToken: validToken, machineId: validMachineId });
  });

  it.each(["accessToken", "machineId"])("preserves an exact %s while finding its missing companion via fuzzy rows", async (exactCredential) => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    const exactRows = exactCredential === "accessToken"
      ? [{ key: "cursorAuth/accessToken", value: validToken }]
      : [{ key: "storage.serviceMachineId", value: validMachineId }];
    mockDbInstance.prepare.mockImplementation((query) => ({ all: vi.fn().mockReturnValue(
      query.includes("IN (") ? exactRows : [
        { key: "cursorAuth/otherAccessToken", value: alternateToken },
        { key: "storage.otherMachineId", value: alternateMachineId },
      ],
    ) }));

    expect((await GET()).body).toEqual({
      found: true,
      accessToken: exactCredential === "accessToken" ? validToken : alternateToken,
      machineId: exactCredential === "machineId" ? validMachineId : alternateMachineId,
    });
    expect(mockDbInstance.close).toHaveBeenCalledOnce();
  });

  it.each(["exact", "fuzzy"])("closes the native database after a %s query exception", async (failingQuery) => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    mockDbInstance.prepare.mockImplementation((query) => ({ all: vi.fn(() => {
      if (query.includes("IN (") === (failingQuery === "exact")) throw new Error("Query failed");
      return [];
    }) }));

    const response = await GET();
    expect(response.body.found).toBe(false);
    expect(response.body.windowsManual).toBe(true);
    expect(mockDbInstance.close).toHaveBeenCalledOnce();
  });

  it("returns login-prompt error when tokens are missing even after fallback", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    mockDbInstance.prepare.mockReturnValue({
      all: vi.fn().mockReturnValue([]),
    });

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain("Please login to Cursor IDE first");
    expect(mockDbInstance.close).toHaveBeenCalledOnce();
  });

  // ── Linux keeps the original not-found message while probing known paths ─

  it("linux probes known paths and keeps the original error message", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));
    mockDbInstance.__throwOnConstruct = true;

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.error).toBe(
      "Cursor database not found. Make sure Cursor IDE is installed and you are logged in."
    );
    expect(fsPromises.access).toHaveBeenCalledTimes(2);
  });

  it("unsupported platform returns 400", async () => {
    Object.defineProperty(process, "platform", { value: "freebsd", writable: true });

    const response = await GET();

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Unsupported platform");
  });
});
