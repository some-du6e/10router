// Per-endpoint compatibility fixes for user-added OpenAI/Anthropic-compatible
// nodes. Stored on the node and copied onto every connection's
// providerSpecificData, which is where the executor reads them.
//   stripBeta            send no anthropic-beta header at all
//   droppedBetas         beta flags this endpoint rejected (learned at runtime)
//   maxCompletionTokens  rename max_tokens → max_completion_tokens (Snowflake chat)
export const QUIRK_KEYS = ["stripBeta", "droppedBetas", "maxCompletionTokens"];

const FLAG_RE = /^[a-z0-9][a-z0-9._-]{0,80}$/i;

// Keep only known keys with the right types. keepEmpty keeps false/[] so an edit
// can switch a fix back off.
export function sanitizeNodeQuirks(raw, { keepEmpty = false } = {}) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const k of ["stripBeta", "maxCompletionTokens"]) {
    if (typeof raw[k] === "boolean" && (raw[k] || keepEmpty)) out[k] = raw[k];
  }
  if (Array.isArray(raw.droppedBetas)) {
    const flags = [...new Set(raw.droppedBetas.map((f) => String(f).trim()).filter((f) => FLAG_RE.test(f)))].slice(0, 50);
    if (flags.length || keepEmpty) out.droppedBetas = flags;
  }
  return out;
}
