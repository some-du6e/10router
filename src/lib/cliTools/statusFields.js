import { getApiKeys } from "@/lib/localDb";

// CLI tool status responses reach remote dashboard sessions (/api/cli-tools/all-statuses
// is not local-only), so each GET returns the fields its card reads, never a whole
// config file: those hold other providers' keys, tokens and headers.

// A key read from a tool's config, returned only when it is one of this instance's
// own client keys (the dashboard lists those anyway), so the card can preselect it.
export async function ownClientKeyOrNull(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const keys = await getApiKeys();
    return keys.some((k) => k?.key === value) ? value : null;
  } catch {
    return null;
  }
}

// The named fields of an object that are set.
export function pickFields(source, names) {
  const out = {};
  if (!source || typeof source !== "object") return out;
  for (const name of names) {
    if (source[name] !== undefined) out[name] = source[name];
  }
  return out;
}
