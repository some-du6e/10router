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

// Keywords whose value maps names to subschemas (besides the definitions above).
export const JSON_SCHEMA_SCHEMA_MAP = {
  PROPERTIES: "properties",
  PATTERN_PROPERTIES: "patternProperties",
  DEPENDENT_SCHEMAS: "dependentSchemas",
};

// Keywords whose value is instance data, never a subschema.
export const JSON_SCHEMA_LITERAL = {
  CONST: "const",
  ENUM: "enum",
  DEFAULT: "default",
  EXAMPLES: "examples",
};

// Vendor extension keywords ("x-…") hold annotation data.
export const JSON_SCHEMA_EXTENSION_PREFIX = "x-";
