import REGISTRY from "open-sse/providers/registry/index.js";

// Names a user-added endpoint can't use as its prefix. Routing resolves
// `prefix/model` against built-in provider ids and aliases first
// (RESERVED_PROVIDER_PREFIXES in src/sse/services/model.js), so a node with one
// of these prefixes would never get traffic. This mirrors that set exactly:
// registry id + alias + aliases, plus model.js's LOCAL_PROVIDER_ALIASES keys.
// `uiAlias` is display-only and isn't routed, so it's not reserved.
type RegistryNames = { id?: unknown; alias?: unknown; aliases?: unknown[] };

const LOCAL_PROVIDER_ALIASES = ["xmtp", "xiaomi-tokenplan"];

const reserved = new Set<string>(LOCAL_PROVIDER_ALIASES);
for (const entry of REGISTRY as readonly RegistryNames[]) {
  for (const name of [entry.id, entry.alias, ...(entry.aliases || [])]) {
    if (typeof name === "string" && name) reserved.add(name.toLowerCase());
  }
}

export const RESERVED_PREFIXES = [...reserved].sort();

export const PREFIX_MAX_LENGTH = 32;
const PREFIX_FORMAT = /^[a-z0-9-]+$/;

export function isReservedPrefix(prefix: unknown): boolean {
  return reserved.has(String(prefix || "").trim().toLowerCase());
}

// Null when the prefix is well-formed: lowercase letters, digits and hyphens,
// at most PREFIX_MAX_LENGTH characters (what the Add endpoint modal allows).
export function prefixFormatProblem(prefix: unknown): string | null {
  const p = String(prefix || "").trim();
  if (!p) return "Prefix is required";
  if (p.length > PREFIX_MAX_LENGTH) return `Prefix can be at most ${PREFIX_MAX_LENGTH} characters.`;
  if (!PREFIX_FORMAT.test(p)) return "Prefix can only use lowercase letters, digits and hyphens.";
  return null;
}

// Null when the prefix is usable, else a message for the user. `nodes` are the
// existing provider nodes; `selfId` skips the node being edited.
type PrefixNode = { id?: unknown; prefix?: unknown; name?: unknown };

export function prefixProblem(
  prefix: unknown,
  { nodes = [], selfId = null }: { nodes?: readonly PrefixNode[]; selfId?: unknown } = {},
): string | null {
  const format = prefixFormatProblem(prefix);
  if (format) return format;
  const p = String(prefix).trim().toLowerCase();
  if (reserved.has(p)) return `"${p}" is a built-in provider's name, so requests for ${p}/… would go there instead. Pick another prefix.`;
  const clash = nodes.find((n) => n.id !== selfId && String(n.prefix || "").trim().toLowerCase() === p);
  if (clash) return `"${p}" is already used by ${String(clash.name || "another endpoint")}. Pick another prefix.`;
  return null;
}
