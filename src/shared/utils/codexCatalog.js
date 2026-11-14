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

/**
 * Can this Codex version use model_catalog_url? False for an unknown version.
 * A source build reports 0.0.0 and counts as the newest, as in the catalog.
 */
export function codexReadsCatalogUrl(version) {
  if (!Array.isArray(version)) return false;
  if (version.every((n) => n === 0)) return true;
  for (let i = 0; i < 3; i++) if (version[i] !== CATALOG_URL_FROM[i]) return version[i] > CATALOG_URL_FROM[i];
  return true;
}

/**
 * The model_catalog_url lines for the Codex card's manual config: always
 * commented out, so a config pasted as is behaves as without the catalog. The
 * card can't tell which Codex will read it or which key it will log in with.
 * @param {string} baseUrl the Codex base URL (…/backend-api/codex)
 * @returns {string} lines ending in "\n"
 */
export function manualCatalogLines(baseUrl) {
  return [
    "# Uncomment on Codex 0.166 or newer when the key Codex logs in with lists your model",
    "# under the exact id set above (no bare-name allowlist entry for it):",
    `# model_catalog_url = "${baseUrl}/models"`,
  ].join("\n") + "\n";
}
