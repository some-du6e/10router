// A model id placed in an upstream URL path. Escaping "/", "?", "#" and "%"
// keeps a crafted id ("x/../other-model#") from turning into a different
// upstream model than the one priced and logged. ":" and "@" are legal inside
// a segment and appear in real ids, so they stay.
import { isReservedLockName } from "../services/accountFallback.js";

function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%3A/gi, ":").replace(/%40/g, "@");
}

// URL parsers resolve "." and ".." segments, and an upstream may decode
// "%2e" (any case) before it routes, so a segment that is or decodes to
// one is refused, as is an empty one.
function isUnsafeSegment(segment: string): boolean {
  let decoded = segment;
  try { decoded = decodeURIComponent(segment); } catch { /* keep as is */ }
  return /^\.{0,2}$/.test(segment) || /^\.{1,2}$/.test(decoded);
}

function refuse(id: string): never {
  throw new Error(`Invalid model id "${id}"`);
}

/** The model id as exactly one path segment (Gemini, Vertex, Azure). */
export function modelPathSegment(model: unknown): string {
  const id = String(model ?? "");
  if (isUnsafeSegment(id)) refuse(id);
  return encodeSegment(id);
}

/**
 * Why a requested model id can never be sent upstream, or null when it can.
 * Handlers check this before they pick an account, so a refused id is the
 * client's 400 and locks no account. Refused everywhere: a name the router's
 * own locks use (`__all`, `websearch:…`, `webfetch:…`), and an id that is
 * empty (a bare "provider/"), "." or "..", plainly or percent-encoded (the
 * modelPathSegment rule, for chat and embeddings, which escape a "/" in the
 * id). With `segments`, for handlers whose providers keep "/" in the path
 * (images, speech, transcription), each "/"-separated part is checked the
 * same way (the modelPathSegments rule).
 */
export function modelIdProblem(model: unknown, { segments = false }: { segments?: boolean } = {}): string | null {
  const id = String(model ?? "");
  if (id && isReservedLockName(id)) return `Model id "${id}" is reserved`;
  try {
    if (segments) modelPathSegments(id);
    else modelPathSegment(id);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

/**
 * A model id whose "/" separates path segments (Hugging Face "org/name",
 * Cloudflare "@cf/vendor/name", fal.ai "vendor/model/variant"): each segment
 * escaped on its own, and none empty, ".", ".." or encoding one of those.
 */
export function modelPathSegments(model: unknown): string {
  const id = String(model ?? "");
  const segments = id.split("/");
  if (segments.some(isUnsafeSegment)) refuse(id);
  return segments.map(encodeSegment).join("/");
}
