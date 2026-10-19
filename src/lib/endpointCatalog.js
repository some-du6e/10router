// The models.dev provider index ("Add endpoint" candidate model ids), written by
// the daily catalog sync. Falls back to fetching it once when the sync hasn't run
// yet (fresh install, or MODEL_CATALOG_SYNC=off), so detection never depends on
// anything hardcoded.
import fs from "node:fs";
import { CATALOG_ENDPOINTS_FILE } from "open-sse/providers/catalogOverride.js";

const CATALOG_URL = "https://models.dev/api.json";
let fallback = null; // in-memory copy when there's no file

// { providers: [{ id, name, api, models }], labs: [{ id, lab, family, date }] }
const normalize = (raw) => Array.isArray(raw) ? { providers: raw, labs: [] } : { providers: raw?.providers || [], labs: raw?.labs || [] };

export async function getEndpointCatalog() {
  try {
    return normalize(JSON.parse(fs.readFileSync(CATALOG_ENDPOINTS_FILE, "utf8")));
  } catch { /* not synced yet */ }
  if (fallback) return fallback;
  try {
    const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(15000) });
    const { buildEndpointIndex } = await import("@/lib/modelCatalog/sync.js");
    fallback = normalize(buildEndpointIndex(await res.json()));
  } catch {
    fallback = { providers: [], labs: [] };
  }
  return fallback;
}
