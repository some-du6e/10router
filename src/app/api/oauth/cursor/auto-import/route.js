import { NextResponse } from "next/server";
import { access, constants } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

const ACCESS_TOKEN_KEYS = ["cursorAuth/accessToken", "cursorAuth/token"];
const MACHINE_ID_KEYS = [
  "storage.serviceMachineId",
  "storage.machineId",
  "telemetry.machineId",
];

const LINUX_NOT_FOUND =
  "Cursor database not found. Make sure Cursor IDE is installed and you are logged in.";
const MACOS_NOT_FOUND =
  "Cursor database not found in known macOS locations. Make sure Cursor IDE is installed and opened at least once.";
const LOGIN_PROMPT = "Please login to Cursor IDE first, then retry auto-import.";

/** Get candidate db paths by platform (linux uses a single hardcoded path). */
function getCandidatePaths(platform) {
  const home = homedir();

  if (platform === "darwin") {
    return [
      join(home, "Library/Application Support/Cursor/User/globalStorage/state.vscdb"),
      join(home, "Library/Application Support/Cursor - Insiders/User/globalStorage/state.vscdb"),
    ];
  }

  if (platform === "linux") {
    return [join(home, ".config/Cursor/User/globalStorage/state.vscdb")];
  }

  return null;
}

/** Unwrap a JSON-encoded string value: '"foo"' → 'foo'. Non-strings pass through. */
function normalizeValue(value) {
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string" ? parsed : value;
  } catch {
    return value;
  }
}

/**
 * Extract tokens via better-sqlite3 (bundled dependency).
 * Tries exact key lookups first, then a fuzzy LIKE fallback for renamed keys.
 * Dynamic import keeps the route importable even if native bindings fail.
 * @returns {Promise<{accessToken:string|null, machineId:string|null}>}
 */
async function extractTokensViaBetterSqlite(dbPath) {
  const mod = await import("better-sqlite3");
  const Database = mod.default || mod;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  try {
    // Exact-key query: select all candidate rows in one statement.
    const placeholders = [...ACCESS_TOKEN_KEYS, ...MACHINE_ID_KEYS]
      .map((k) => `'${k.replace(/'/g, "''")}'`)
      .join(", ");
    const exactRows = db
      .prepare(`SELECT key, value FROM itemTable WHERE key IN (${placeholders})`)
      .all();

    let accessToken = null;
    let machineId = null;
    for (const row of exactRows) {
      if (accessToken === null && ACCESS_TOKEN_KEYS.includes(row.key)) {
        accessToken = normalizeValue(row.value);
      } else if (machineId === null && MACHINE_ID_KEYS.includes(row.key)) {
        machineId = normalizeValue(row.value);
      }
    }

    // Fuzzy fallback: when exact keys are missing (renamed across Cursor
    // versions), match by substring so a fresh install still imports. The query
    // has no inherent row order, so rank candidates deterministically: an
    // access-token key beats a generic token key, and a Cursor-namespaced key
    // (cursorAuth/cursor) beats an unrelated app's key. The SQL ORDER BY asks
    // SQLite for that order, and the in-JS ranking below re-applies it so the
    // result is correct even if the driver returns rows in another order — an
    // unrelated app's `…token…` row must never be returned as Cursor's
    // accessToken when a renamed Cursor access-token key is present.
    if (!accessToken || !machineId) {
      const fuzzyRows = db
        .prepare(
          `SELECT key, value FROM itemTable
             WHERE key LIKE '%Token%' OR key LIKE '%achineId%'
             ORDER BY
               CASE
                 WHEN lower(key) LIKE '%accesstoken%'                      THEN 0
                 WHEN lower(key) LIKE '%cursorauth%' AND lower(key) LIKE '%token%' THEN 1
                 WHEN lower(key) LIKE '%cursor%'    AND lower(key) LIKE '%token%' THEN 2
                 WHEN lower(key) LIKE '%machineid%' AND lower(key) LIKE '%cursor%' THEN 3
                 WHEN lower(key) LIKE '%machineid%'                          THEN 4
                 WHEN lower(key) LIKE '%token%'                              THEN 5
                 ELSE 9
               END`,
        )
        .all();

      // Collect the best candidate per slot by rank (lower rank = better),
      // rather than first-match-wins, so row order can't change the outcome.
      let bestAccessToken = null, bestAccessTokenRank = Infinity;
      let bestMachineId = null, bestMachineIdRank = Infinity;
      const rank = (key) => {
        const k = key.toLowerCase();
        if (k.includes("accesstoken")) return 0;
        if (k.includes("cursorauth") && k.includes("token")) return 1;
        if (k.includes("cursor") && k.includes("token")) return 2;
        if (k.includes("machineid") && k.includes("cursor")) return 3;
        if (k.includes("machineid")) return 4;
        if (k.includes("token")) return 5;
        return 9;
      };
      for (const row of fuzzyRows) {
        const key = String(row.key || "");
        const r = rank(key);
        if (!accessToken && r < bestAccessTokenRank && key.toLowerCase().includes("token")) {
          bestAccessToken = normalizeValue(row.value);
          bestAccessTokenRank = r;
        } else if (!machineId && r < bestMachineIdRank && key.toLowerCase().includes("machineid")) {
          bestMachineId = normalizeValue(row.value);
          bestMachineIdRank = r;
        }
      }
      if (!accessToken) accessToken = bestAccessToken;
      if (!machineId) machineId = bestMachineId;
    }

    return { accessToken, machineId };
  } finally {
    db.close();
  }
}

/**
 * GET /api/oauth/cursor/auto-import
 * Auto-detect and extract Cursor tokens from the local SQLite database.
 * macOS probes several known db locations; Linux uses a single hardcoded path
 * (no filesystem probing); other platforms are unsupported.
 */
export async function GET() {
  const platform = process.platform;

  if (platform !== "darwin" && platform !== "linux") {
    return NextResponse.json(
      { found: false, error: "Unsupported platform" },
      { status: 400 },
    );
  }

  const candidates = getCandidatePaths(platform);
  let dbPath = null;

  // macOS: probe candidate paths for readability.
  if (platform === "darwin") {
    for (const candidate of candidates) {
      try {
        await access(candidate, constants.R_OK);
        dbPath = candidate;
        break;
      } catch {
        // try next candidate
      }
    }
    if (!dbPath) {
      return NextResponse.json({ found: false, error: MACOS_NOT_FOUND });
    }
  } else {
    // Linux: single hardcoded path — skip filesystem probing (backward compat).
    dbPath = candidates[0];
  }

  // Open the db and extract tokens.
  let tokens;
  try {
    tokens = await extractTokensViaBetterSqlite(dbPath);
  } catch (error) {
    if (platform === "linux") {
      // Backward-compatible generic message for the single-path platform.
      return NextResponse.json({ found: false, error: LINUX_NOT_FOUND });
    }
    // macOS: surface a descriptive "could not open" error including the raw code.
    const code = error?.code || error?.message || "unknown";
    return NextResponse.json({
      found: false,
      error: `Found Cursor database at ${dbPath} but could not open it (${code}).`,
    });
  }

  if (tokens.accessToken && tokens.machineId) {
    return NextResponse.json({
      found: true,
      accessToken: tokens.accessToken,
      machineId: tokens.machineId,
    });
  }

  // Tokens missing even after the fuzzy fallback — prompt the user to log in.
  return NextResponse.json({ found: false, error: LOGIN_PROMPT });
}
