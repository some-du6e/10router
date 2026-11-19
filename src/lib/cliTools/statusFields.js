import { getApiKeys } from "@/lib/localDb";

// CLI tool status responses reach remote dashboard sessions (/api/cli-tools/all-statuses
// is not local-only), so each GET returns the fields its card reads, never a whole
// config file: those hold other providers' keys, tokens and headers.

async function ownKeyMatching(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const keys = await getApiKeys();
    return keys.find((k) => k?.key === value) || null;
  } catch {
    return null;
  }
}

// What a card may know about the key in a tool's config, without the key itself:
// whether one is set, and which of this instance's client keys it is (by id). A
// card that gets set without ownKeyId shows the key as kept and sends
// KEEP_EXISTING_KEY (keepKey.js) on Apply.
export async function keyStatus(value) {
  const set = typeof value === "string" && value.length > 0;
  const own = set ? await ownKeyMatching(value) : null;
  return { set, ownKeyId: own?.id ?? null };
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
