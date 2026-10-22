// Responses clients (Codex) call tools by `{ name, namespace }`; Chat and Claude
// upstreams see one flat list. Maps the upstream name back: to a namespace when
// the name is unchanged, or to `{ namespace, name }` when it was qualified.
export type ToolNamespaceEntry = string | { namespace: string; name: string };
export type ToolNamespaces = Map<string, ToolNamespaceEntry> | Record<string, ToolNamespaceEntry> | null | undefined;

// Anthropic caps tool names at 64 chars of [a-zA-Z0-9_-]; OAuth cloaking appends CLAUDE_TOOL_SUFFIX.
const MAX_TOOL_NAME_LEN = 64 - "_ide".length;

// MCP namespaces end in `__server` and their tools start with `_`, so plain
// concatenation reproduces the full MCP name (mcp__codex_apps__notion_fetch).
export function qualifyToolName(namespace: string, name: string): string {
  const raw = name.startsWith("_") ? `${namespace}${name}` : `${namespace}__${name}`;
  const qualified = raw.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (qualified.length <= MAX_TOOL_NAME_LEN) return qualified;
  return `${qualified.slice(0, MAX_TOOL_NAME_LEN - 9)}_${hash8(raw)}`;
}

// The name and namespace the client declared for a tool the upstream called by `wireName`.
export function clientToolRef(toolNamespaces: ToolNamespaces, wireName: string): { name: string; namespace: string | null } {
  if (!wireName || !toolNamespaces) return { name: wireName, namespace: null };
  const entry = toolNamespaces instanceof Map
    ? toolNamespaces.get(wireName)
    : Object.hasOwn(toolNamespaces, wireName) ? toolNamespaces[wireName] : undefined;
  if (!entry) return { name: wireName, namespace: null };
  if (typeof entry === "string") return { name: wireName, namespace: entry };
  return { name: entry.name, namespace: entry.namespace };
}

function hash8(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
