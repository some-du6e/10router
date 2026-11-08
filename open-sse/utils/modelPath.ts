// A model id placed in an upstream URL path, as exactly one path segment.
// Escaping "/", "?", "#" and "%" keeps a crafted id ("x/../other-model#")
// from turning into a different upstream model than the one priced and logged.
// ":" and "@" are legal inside a segment and appear in real ids, so they stay.
export function modelPathSegment(model: unknown): string {
  const id = String(model ?? "");
  // URL parsers resolve "." and ".." segments even when percent-encoded.
  if (/^\.{0,2}$/.test(id)) throw new Error(`Invalid model id "${id}"`);
  return encodeURIComponent(id).replace(/%3A/gi, ":").replace(/%40/g, "@");
}
