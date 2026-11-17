import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const isPosix = process.platform !== "win32";
const mode = (p) => fs.statSync(p).mode & 0o777;

let umask;
let root;

beforeEach(() => {
  umask = process.umask(0o022);
  root = fs.mkdtempSync(path.join(os.tmpdir(), "10r-dbperm-"));
  vi.resetModules();
});

afterEach(() => {
  process.umask(umask);
  vi.unstubAllEnvs();
  vi.doUnmock("../../src/lib/db/paths.js");
  fs.rmSync(root, { recursive: true, force: true });
});

describe.runIf(isPosix)("database file permissions", () => {
  it("sql.js writes a fresh database file owner-only", async () => {
    const { createSqlJsAdapter } = await import("../../src/lib/db/adapters/sqljsAdapter.js");
    const file = path.join(root, "data.sqlite");
    const adapter = await createSqlJsAdapter(file);
    adapter.run("CREATE TABLE t(x)");
    adapter.close();
    expect(fs.existsSync(file)).toBe(true);
    expect(mode(file)).toBe(0o600);
  });

  it("tightens the JSON files a pre-SQLite install left in DATA_DIR", async () => {
    vi.stubEnv("DATA_DIR", root);
    const { restrictDbFilePermissions, LEGACY_FILES } = await import("../../src/lib/db/paths.js");
    for (const file of Object.values(LEGACY_FILES)) fs.writeFileSync(file, "{}", { mode: 0o644 });

    restrictDbFilePermissions();

    for (const file of Object.values(LEGACY_FILES)) expect(mode(file)).toBe(0o600);
  });

  it("keeps the mode of a DATA_DIR the user chose, and makes db/ owner-only", async () => {
    const chosen = path.join(root, "shared");
    fs.mkdirSync(chosen, { mode: 0o755 });
    vi.stubEnv("DATA_DIR", chosen);
    const { ensureDirs, DB_DIR, BACKUPS_DIR } = await import("../../src/lib/db/paths.js");

    ensureDirs();

    expect(mode(chosen)).toBe(0o755);
    expect(mode(DB_DIR)).toBe(0o700);
    expect(mode(BACKUPS_DIR)).toBe(0o700);
  });

  it("the driver tightens the database files once the adapter has opened them", async () => {
    vi.stubEnv("DATA_DIR", root);
    const calls = [];
    vi.doMock("../../src/lib/db/paths.js", async (importOriginal) => {
      const real = await importOriginal();
      return {
        ...real,
        restrictDbFilePermissions: () => {
          calls.push(fs.existsSync(real.DATA_FILE));
          real.restrictDbFilePermissions();
        },
      };
    });
    const saved = globalThis._dbAdapter;
    globalThis._dbAdapter = undefined;
    vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { getAdapter } = await import("../../src/lib/db/driver.js");
      const adapter = await getAdapter();
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const { DATA_FILE } = await import("../../src/lib/db/paths.js");
      if (fs.existsSync(DATA_FILE)) expect(mode(DATA_FILE)).toBe(0o600);
      adapter.close?.();
    } finally {
      globalThis._dbAdapter = saved;
      vi.restoreAllMocks();
    }
  });
});
