import { NextResponse } from "next/server";
import { access, constants } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { isValidCursorAccessToken, isValidCursorMachineId } from "@/lib/oauth/cursorCredentials.js";

const execFileAsync = promisify(execFile);

const ACCESS_TOKEN_KEYS = ["cursorAuth/accessToken", "cursorAuth/token"];
const MACHINE_ID_KEYS = [
  "storage.serviceMachineId",
  "storage.machineId",
  "telemetry.machineId",
];

/** Get candidate db paths by platform */
function getCandidatePaths(platform) {
  const home = homedir();

  if (platform === "darwin") {
    return [
      join(
        home,
        "Library/Application Support/Cursor/User/globalStorage/state.vscdb",
      ),
      join(
        home,
        "Library/Application Support/Cursor - Insiders/User/globalStorage/state.vscdb",
      ),
    ];
  }

  if (platform === "win32") {
    const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
    const localAppData =
      process.env.LOCALAPPDATA || join(home, "AppData", "Local");
    return [
      join(appData, "Cursor", "User", "globalStorage", "state.vscdb"),
      join(
        appData,
        "Cursor - Insiders",
        "User",
        "globalStorage",
        "state.vscdb",
      ),
      join(localAppData, "Cursor", "User", "globalStorage", "state.vscdb"),
      join(
        localAppData,
        "Programs",
        "Cursor",
        "User",
        "globalStorage",
        "state.vscdb",
      ),
    ];
  }

  return [
    join(home, ".config/Cursor/User/globalStorage/state.vscdb"),
    join(home, ".config/cursor/User/globalStorage/state.vscdb"),
  ];
}

const normalize = (value) => {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === "string") return parsed.trim();
    return typeof parsed === "number" ? value.trim() : null;
  } catch {
    return value.trim();
  }
};

/**
 * Extract tokens via better-sqlite3 (bundled dependency).
 * This is the preferred strategy — no external CLI required.
 */
async function extractTokensViaBetterSqlite(dbPath) {
  // Dynamic import keeps the route usable when the optional native binding is unavailable.
  const betterSqlite3Module = await import("better-sqlite3");
  const Database = betterSqlite3Module.default || betterSqlite3Module;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const desiredKeys = [...ACCESS_TOKEN_KEYS, ...MACHINE_ID_KEYS];
    const placeholders = desiredKeys.map(() => "?").join(",");
    const exactRows = db
      .prepare(`SELECT key, value FROM itemTable WHERE key IN (${placeholders})`)
      .all(...desiredKeys);

    const valuesByKey = new Map(exactRows.map((row) => [row.key, normalize(row.value)]));
    const tokens = {
      accessToken: ACCESS_TOKEN_KEYS.map((key) => valuesByKey.get(key)).find(isValidCursorAccessToken),
      machineId: MACHINE_ID_KEYS.map((key) => valuesByKey.get(key)).find(isValidCursorMachineId),
    };

    if (!tokens.accessToken || !tokens.machineId) {
      const fallbackRows = db.prepare(
        "SELECT key, value FROM itemTable WHERE key LIKE '%cursorAuth/%' OR key LIKE '%machineId%' OR key LIKE '%serviceMachineId%'"
      ).all();
      for (const row of fallbackRows) {
        const key = String(row.key || "").toLowerCase();
        const value = normalize(row.value);
        if (!tokens.accessToken && key.includes("accesstoken") && isValidCursorAccessToken(value)) tokens.accessToken = value;
        if (!tokens.machineId && key.includes("machineid") && isValidCursorMachineId(value)) tokens.machineId = value;
      }
    }

    return tokens;
  } finally {
    db.close();
  }
}

/**
 * Extract tokens via sqlite3 CLI.
 * Fallback when better-sqlite3 native bindings are unavailable.
 */
async function extractTokensViaCLI(dbPath) {
  let databaseRead = false;
  const query = async (sql) => {
    const { stdout } = await execFileAsync("sqlite3", [dbPath, sql], {
      timeout: 10000,
    });
    databaseRead = true;
    return stdout.trim();
  };

  // Try each key in priority order
  let accessToken = null;
  for (const key of ACCESS_TOKEN_KEYS) {
    try {
      const raw = await query(
        `SELECT value FROM itemTable WHERE key='${key}' LIMIT 1`,
      );
      const value = normalize(raw);
      if (isValidCursorAccessToken(value)) {
        accessToken = value;
        break;
      }
    } catch {
      /* try next */
    }
  }

  let machineId = null;
  for (const key of MACHINE_ID_KEYS) {
    try {
      const raw = await query(
        `SELECT value FROM itemTable WHERE key='${key}' LIMIT 1`,
      );
      const value = normalize(raw);
      if (isValidCursorMachineId(value)) {
        machineId = value;
        break;
      }
    } catch {
      /* try next */
    }
  }

  return { accessToken, machineId, databaseRead };
}

/**
 * GET /api/oauth/cursor/auto-import
 * Auto-detect and extract Cursor tokens from local SQLite database.
 * Strategy: better-sqlite3 → sqlite3 CLI → manual fallback
 */
export async function GET() {
  try {
    const platform = process.platform;
    if (!["darwin", "win32", "linux"].includes(platform)) {
      return NextResponse.json({ error: "Unsupported platform" }, { status: 400 });
    }

    const candidates = getCandidatePaths(platform);

    let dbPath = null;
    for (const candidate of candidates) {
      try {
        await access(candidate, constants.R_OK);
        dbPath = candidate;
        break;
      } catch {
        // Try next candidate
      }
    }

    if (!dbPath) {
      return NextResponse.json({
        found: false,
        error: platform === "darwin"
          ? `Cursor database not found in known macOS locations. Checked locations:\n${candidates.join("\n")}\n\nMake sure Cursor IDE is installed and opened at least once.`
          : "Cursor database not found. Make sure Cursor IDE is installed and you are logged in.",
      });
    }

    // On Linux, verify Cursor is actually installed (not just leftover config)
    if (platform === "linux") {
      let cursorInstalled = false;
      try {
        await execFileAsync("which", ["cursor"], { timeout: 5000 });
        cursorInstalled = true;
      } catch {
        try {
          const desktopFile = join(homedir(), ".local/share/applications/cursor.desktop");
          await access(desktopFile, constants.R_OK);
          cursorInstalled = true;
        } catch { /* not found */ }
      }
      if (!cursorInstalled) {
        return NextResponse.json({
          found: false,
          error: "Cursor config files found but Cursor IDE does not appear to be installed. Skipping auto-import.",
        });
      }
    }

    // Strategy 1: better-sqlite3 (bundled — no external tools required)
    let nativeDbError = null;
    let databaseRead = false;
    try {
      const tokens = await extractTokensViaBetterSqlite(dbPath);
      databaseRead = true;
      if (tokens.accessToken && tokens.machineId) {
        return NextResponse.json({
          found: true,
          accessToken: tokens.accessToken,
          machineId: tokens.machineId,
        });
      }
    } catch (error) {
      nativeDbError = error;
      // Native bindings unavailable — try CLI fallback
    }

    // Strategy 2: sqlite3 CLI
    try {
      const tokens = await extractTokensViaCLI(dbPath);
      databaseRead ||= tokens.databaseRead;
      if (tokens.accessToken && tokens.machineId) {
        return NextResponse.json({
          found: true,
          accessToken: tokens.accessToken,
          machineId: tokens.machineId,
        });
      }
    } catch {
      // sqlite3 CLI not available either
    }

    // Strategy 3: ask user to paste manually
    if (!databaseRead && nativeDbError && /CANTOPEN|unable to open|not a database/i.test(nativeDbError.message || "")) {
      return NextResponse.json({
        found: false,
        error: `Cursor database could not be opened: ${nativeDbError.message}`,
      });
    }

    if (platform === "darwin" && databaseRead) {
      return NextResponse.json({
        found: false,
        error: "Please login to Cursor IDE first, then retry auto-import.",
      });
    }

    return NextResponse.json({ found: false, windowsManual: true, dbPath });
  } catch (error) {
    console.log("Cursor auto-import error:", error);
    return NextResponse.json(
      { found: false, error: error.message },
      { status: 500 },
    );
  }
}
