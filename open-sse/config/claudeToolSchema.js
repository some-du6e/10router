// Limits and wording for flattening Claude tool input schemas
// (translator/concerns/jsonSchema.js).

export const CLAUDE_TOOL_SCHEMA_LIMITS = {
  // Only small schemas are flattened. Anything over either cap gets the
  // permissive fallback at once; tool schemas that start with a combinator are
  // far smaller in practice. Bytes are estimated by a walk that stops at the
  // cap; nodes are objects and arrays.
  MAX_INPUT_BYTES: 64 * 1024,
  MAX_INPUT_NODES: 4000,
  // Work units for flattening one schema: a member visited, a key copied, a
  // property merged, a required key compared. Past it, the permissive fallback.
  MAX_STEPS: 20_000,
  // Nested combinators and $ref hops, per path.
  MAX_DEPTH: 8,
  // The flattened schema may hold at most this many times the input's nodes
  // (a $ref member repeats the subtree it points at); past it, the permissive fallback.
  MAX_GROWTH: 2,
  // Alternatives named in the description, characters per name, required keys
  // or type entries per name, and characters of such summaries per schema level.
  MAX_LISTED: 6,
  MAX_LABEL: 80,
  MAX_LABEL_KEYS: 8,
  MAX_NOTES: 500,
  // A fallback keeps at most this much of the tool's own description.
  MAX_FALLBACK_DESCRIPTION: 1024,
  // Characters of a string looked at to decide whether it's blank.
  MAX_BLANK_SCAN: 1024,
  // Two alternatives' definitions of a property count as the same when their
  // JSON matches and is at most this long; longer ones only when identical objects.
  MAX_KEY_LENGTH: 256,
};

export const CLAUDE_TOOL_SCHEMA_TEXT = {
  ONE_OF: "Accepts one of",
  ALL_OF: "Must match all of",
  // "{n}" is replaced with the number of alternatives left out.
  MORE: "and {n} more",
  OBJECT: "an object",
  VALUE: "a value",
  TYPED: "a {type}",
};
