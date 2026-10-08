import { OPENAI_BLOCK } from "../schema/index.js";

// Collapse text-only content-part arrays while preserving multimodal structure.
export function collapseTextParts(parts) {
  const canCollapse = parts.length > 0
    && parts.every((part) => part.type === OPENAI_BLOCK.TEXT)
    && !parts.some((part) => part.cache_control);

  return canCollapse
    ? parts.map((part) => part.text || "").join("\n")
    : parts;
}
