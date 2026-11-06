// Endpoint URL normalisation shared by the server (connectionBaseUrl.ts) and
// the dashboard. No node:* imports: the dashboard bundles this file.

// API paths people paste along with the base URL. The executor appends them.
const TRAILING_API_PATH = /\/(chat\/completions|messages|responses)$/i;

// Trim, drop trailing slashes and a pasted API path, keep any query string
// (Azure's ?api-version=).
export function normalizeEndpointUrl(raw) {
  const s = String(raw ?? "").trim();
  const q = s.indexOf("?");
  let base = q === -1 ? s : s.slice(0, q);
  for (let prev = ""; prev !== base;) {
    prev = base;
    base = base.replace(/\/+$/, "").replace(TRAILING_API_PATH, "");
  }
  return q === -1 ? base : `${base}${s.slice(q)}`;
}
