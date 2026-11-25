const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

/** The query a search sends (NFKC, whitespace collapsed), or why no provider can take it. */
export function sanitizeQuery(query: string): { clean?: string; error?: string } {
  if (CONTROL_CHAR_RE.test(query)) return { error: "Query contains invalid control characters" };
  const clean = query.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!clean) return { error: "Query is empty after normalization" };
  return { clean };
}
