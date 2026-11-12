import { createHash } from "crypto";
import { CLAUDE_TOOL_SUFFIX } from "../../config/appConstants.js";

// Responses clients (Codex) call tools by `{ name, namespace }`; Chat and Claude
// upstreams see one flat list. The request translator records, for each upstream
// (wire) name that needs it, the name and namespace the client declared; the
// namespace is null for a top-level tool whose name had to be sanitized.

export type ToolRef = { namespace: string | null; name: string };
export type ToolNamespaces = Map<string, ToolRef> | null | undefined;

// Anthropic caps tool names at 64 chars of [a-zA-Z0-9_-]; OAuth cloaking appends CLAUDE_TOOL_SUFFIX.
const MAX_TOOL_NAME_LEN = 64 - CLAUDE_TOOL_SUFFIX.length;
const WIRE_NAME = /^[a-zA-Z0-9_-]+$/;

// Whether an upstream accepts `name` as a tool name as-is.
export function isWireToolName(name: string): boolean {
  return name.length <= MAX_TOOL_NAME_LEN && WIRE_NAME.test(name);
}

// MCP namespaces end in `__server` and their tools start with `_`, so plain
// concatenation reproduces the full MCP name (mcp__codex_apps__docs_fetch).
// A namespace that already ends in `_` is not given a second separator.
export function qualifyToolName(namespace: string | null, name: string): string {
  const raw = !namespace ? name
    : name.startsWith("_") || namespace.endsWith("_") ? `${namespace}${name}` : `${namespace}__${name}`;
  const qualified = raw.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (qualified.length <= MAX_TOOL_NAME_LEN) return qualified;
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 8);
  return `${qualified.slice(0, MAX_TOOL_NAME_LEN - 9)}_${hash}`;
}

// Pull the translator-only tool metadata off a translated request body. It rides
// the body as a plain array/object so it survives the translator pivot; every
// response path takes it as a Set of custom tool wire names and a Map of
// wire name → ToolRef.
export function takeToolMetadata(body: Record<string, unknown>): { customToolNames: Set<string> | null; toolNamespaces: ToolNamespaces } {
  const custom = body._customToolNames as string[] | undefined;
  const namespaces = body._toolNamespaces as Record<string, ToolRef> | undefined;
  delete body._customToolNames;
  delete body._toolNamespaces;
  return {
    customToolNames: custom ? new Set(custom) : null,
    toolNamespaces: namespaces ? new Map(Object.entries(namespaces)) : null,
  };
}

// The name and namespace the client declared for a tool the upstream called by `wireName`.
export function clientToolRef(toolNamespaces: ToolNamespaces, wireName: string): ToolRef {
  return toolNamespaces?.get(wireName) ?? { name: wireName, namespace: null };
}

// The `name` and, for a namespaced tool, `namespace` fields of a Responses tool call item.
export function clientToolFields(toolNamespaces: ToolNamespaces, wireName: string): { name: string; namespace?: string } {
  const { name, namespace } = clientToolRef(toolNamespaces, wireName || "");
  return namespace ? { name, namespace } : { name };
}
