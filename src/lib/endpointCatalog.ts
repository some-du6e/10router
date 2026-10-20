// The models.dev provider index ("Add endpoint" candidate model ids), written by
// the daily catalog sync. Falls back to fetching it once when the sync hasn't run
// yet (fresh install, or MODEL_CATALOG_SYNC=off), so detection never depends on
// anything hardcoded.
import fs from "node:fs";
import { CATALOG_ENDPOINTS_FILE } from "open-sse/providers/catalogOverride.js";

const CATALOG_URL = "https://models.dev/api.json";
const RETRY_AFTER_MS = 5 * 60 * 1000;
export interface CatalogProvider { id: string; name: string; api: string; models: string[] }
export interface CatalogLabModel { id: string; lab: string; family: string; date: string }
export interface EndpointCatalog { providers: CatalogProvider[]; labs: CatalogLabModel[] }

const EMPTY: EndpointCatalog = { providers: [], labs: [] };
let fallback: EndpointCatalog | null = null;    // in-memory copy when there's no file
let inFlight: Promise<EndpointCatalog> | null = null;    // one download shared by concurrent first calls
let failedAt = 0;       // a failed download is retried after RETRY_AFTER_MS, not cached

// { providers: [{ id, name, api, models }], labs: [{ id, lab, family, date }] }
type RawCatalog = CatalogProvider[] | { providers?: CatalogProvider[]; labs?: CatalogLabModel[] } | null | undefined;
const normalize = (raw: RawCatalog): EndpointCatalog => Array.isArray(raw) ? { providers: raw, labs: [] } : { providers: raw?.providers || [], labs: raw?.labs || [] };

async function download(): Promise<EndpointCatalog> {
  const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { buildEndpointIndex } = await import("@/lib/modelCatalog/sync.js");
  return normalize(buildEndpointIndex(await res.json()));
}

export async function getEndpointCatalog(): Promise<EndpointCatalog> {
  try {
    return normalize(JSON.parse(fs.readFileSync(CATALOG_ENDPOINTS_FILE, "utf8")));
  } catch { /* not synced yet */ }
  if (fallback) return fallback;
  if (Date.now() - failedAt < RETRY_AFTER_MS) return EMPTY;
  inFlight ??= download()
    .then((catalog) => { fallback = catalog; return catalog; })
    .catch(() => { failedAt = Date.now(); return EMPTY; })
    .finally(() => { inFlight = null; });
  return inFlight;
}
