// When the Codex config the dashboard writes gets `model_catalog_url`, the
// router's catalog URL. Client-safe: the Codex card's manual config uses it,
// the settings route (src/app/api/cli-tools/codex-settings/route.js) too.
//
// Codex 0.156 added the setting. From 0.160 it puts the provider in explicit
// catalog mode: Codex's own list is dropped, names must match exactly, and a
// failed fetch leaves no models at all. Until 0.166 the fetch also fails for a
// body over 1 MiB, which the router's catalog usually is. So the line is only
// worth writing for Codex 0.166 or newer.
export const CATALOG_URL_FROM = [0, 166, 0];

/** "codex-cli 0.167.2" -> [0, 167, 2]; null when there's no version in it. */
export function parseCodexVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ""));
  return match ? match.slice(1).map(Number) : null;
}

/** Can this Codex version use model_catalog_url? False for an unknown version. */
export function codexReadsCatalogUrl(version) {
  if (!Array.isArray(version)) return false;
  for (let i = 0; i < 3; i++) if (version[i] !== CATALOG_URL_FROM[i]) return version[i] > CATALOG_URL_FROM[i];
  return true;
}

/**
 * Would a key with this allowlist find each of `ids` in the catalog under that
 * exact id? Without an allowlist, yes. With one, only when the allowlist names
 * the id itself; a bare entry ("gpt-5.5") lists the model under the bare name,
 * not "cx/gpt-5.5". This is the browser's view of a key: it can't resolve
 * combos or aliases, so it answers no when unsure.
 */
export function allowlistListsIds(allowedModels, ids) {
  if (!Array.isArray(allowedModels) || allowedModels.length === 0) return true;
  const allowed = new Set(allowedModels.map((entry) => String(entry).trim()));
  return ids.filter(Boolean).every((id) => allowed.has(id));
}

/**
 * The model_catalog_url lines for the Codex card's manual config.
 * @param {string} baseUrl the Codex base URL (…/backend-api/codex)
 * @param {{ allowedModels?: string[] } | null} key the key, if the card knows it
 * @param {string[]} ids the model and subagent model the config sets
 * @returns {string} lines ending in "\n", or "" to leave the setting out
 */
export function manualCatalogLines(baseUrl, key, ids) {
  if (key && !allowlistListsIds(key.allowedModels, ids)) return "";
  const notes = ["# Needs Codex 0.166 or newer; remove for older Codex."];
  if (!key) notes.push("# Remove too if your key's model allowlist doesn't name these models by these exact ids.");
  return `${notes.join("\n")}\nmodel_catalog_url = "${baseUrl}/models"\n`;
}
