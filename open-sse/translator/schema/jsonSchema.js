// JSON Schema keywords the tool-schema translators read and write. Pure data (no logic).

export const JSON_SCHEMA_TYPE = {
  OBJECT: "object",
};

// Keywords that combine member schemas.
export const JSON_SCHEMA_COMBINATOR = {
  ALL_OF: "allOf",
  ANY_OF: "anyOf",
  ONE_OF: "oneOf",
};

export const JSON_SCHEMA_REF = "$ref";

// Where a schema keeps the definitions its $refs point at.
export const JSON_SCHEMA_DEFS = {
  DEFS: "$defs",
  DEFINITIONS: "definitions",
};
