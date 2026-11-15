// Limits and wording for flattening Claude tool input schemas
// (translator/concerns/jsonSchema.js).

export const CLAUDE_TOOL_SCHEMA_LIMITS = {
  // Nested combinators, $ref hops and inlined $refs, per path.
  MAX_DEPTH: 8,
  // Schema nodes visited per tool schema, flattening and $ref repair together.
  // Past it the tool gets the permissive fallback, so one schema can't stall the server.
  MAX_STEPS: 500,
  // Alternatives named in the description, and characters per name.
  MAX_LISTED: 6,
  MAX_LABEL: 80,
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
