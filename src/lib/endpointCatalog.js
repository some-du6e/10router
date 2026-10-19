// The models.dev provider index ("Add endpoint" candidate model ids), written by
// the daily catalog sync. Falls back to fetching it once when the sync hasn't run
// yet (fresh install, or MODEL_CATALOG_SYNC=off), so detection never depends on
// anything hardcoded.
import fs from "node:fs";
import { CATALOG_ENDPOINTS_FILE } from "open-sse/providers/catalogOverride.js";

const CATALOG_URL = "https://models.dev/api.json";
let fallback = null; // in-memory copy when there's no file

export async function getEndpointCatalog() {
  try {
    return JSON.parse(fs.readFileSync(CATALOG_ENDPOINTS_FILE, "utf8"));
  } catch { /* not synced yet */ }
  if (fallback) return fallback;
  try {
    const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(15000) });
    const catalog = await res.json();
    fallback = Object.entries(catalog)
      .map(([id, p]) => ({ id, name: p?.name || id, api: p?.api, models: Object.keys(p?.models || {}) }))
      .filter((p) => p.api && p.models.length);
  } catch {
    fallback = [];
  }
  return fallback;
}
