import REGISTRY from "open-sse/providers/registry/index.js";

// Names a user-added endpoint can't use as its prefix. Routing resolves
// `prefix/model` against built-in provider ids and aliases first (see
// RESERVED_PROVIDER_PREFIXES in src/sse/services/model.js), so a node with one of
// these prefixes would never get traffic. Built from the same registry.
const reserved = new Set();
for (const entry of REGISTRY) {
  for (const name of [entry.id, entry.alias, entry.uiAlias, ...(entry.aliases || [])]) {
    if (typeof name === "string" && name) reserved.add(name.toLowerCase());
  }
}

export const RESERVED_PREFIXES = [...reserved].sort();

export function isReservedPrefix(prefix) {
  return reserved.has(String(prefix || "").trim().toLowerCase());
}

// Null when the prefix is usable, else a message for the user. `nodes` are the
// existing provider nodes; `selfId` skips the node being edited.
export function prefixProblem(prefix, { nodes = [], selfId = null } = {}) {
  const p = String(prefix || "").trim().toLowerCase();
  if (!p) return "Prefix is required";
  if (reserved.has(p)) return `"${p}" is a built-in provider's name, so requests for ${p}/… would go there instead. Pick another prefix.`;
  const clash = nodes.find((n) => n.id !== selfId && String(n.prefix || "").toLowerCase() === p);
  if (clash) return `"${p}" is already used by ${clash.name || "another endpoint"}. Pick another prefix.`;
  return null;
}
