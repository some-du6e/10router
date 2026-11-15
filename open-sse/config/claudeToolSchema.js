// Limits and wording for flattening Claude tool input schemas
// (translator/concerns/jsonSchema.js).

export const CLAUDE_TOOL_SCHEMA_LIMITS = {
  // A bigger schema (all nodes, or roughly its JSON size) isn't flattened at
  // all: the tool gets the permissive fallback.
  MAX_INPUT_NODES: 200_000,
  MAX_INPUT_BYTES: 1_000_000,
  // Work units for the combinator / $ref flattening of one schema: one per
  // member visited, per property merged, per required key compared. Past it
  // the tool gets the permissive fallback, so one schema can't stall the server.
  MAX_STEPS: 20_000,
  // Nested combinators and $ref hops, per path.
  MAX_DEPTH: 8,
  // The flattened schema may hold at most this many times the input's nodes
  // (a $ref member can repeat a subtree); past it, the permissive fallback.
  MAX_GROWTH: 2,
  // Alternatives named in the description, characters per name, and
  // characters of such summaries added per schema level.
  MAX_LISTED: 6,
  MAX_LABEL: 80,
  MAX_NOTES: 500,
  // Two alternatives' definitions of a property count as the same when their
  // JSON matches and is at most this long; longer ones only when identical objects.
  MAX_KEY_LENGTH: 256,
  // Required keys named in a label.
  MAX_LABEL_KEYS: 8,
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
