import { OPENAI_BLOCK } from "../schema/index.js";

// Collapse an OpenAI content-part array into a plain string when it carries
// only text: a single text part becomes its text, and multiple text parts are
// joined with "\n". Multimodal arrays (images, etc.) are returned as-is so the
// structured parts survive the OpenAI leg.
export function collapseTextParts(parts) {
  if (!Array.isArray(parts) || parts.length === 0) return parts;
  if (parts.every(p => p?.type === OPENAI_BLOCK.TEXT)) {
    return parts.map(p => p.text ?? "").join("\n");
  }
  return parts;
}
