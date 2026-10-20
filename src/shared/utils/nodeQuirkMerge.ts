import { sanitizeNodeQuirks, QUIRK_KEYS } from "./nodeQuirks.js";
import type { NodeQuirks } from "./nodeQuirks.js";

// Stored node / providerSpecificData records: quirk fields plus anything else.
type QuirkHolder = Record<string, unknown> & { droppedBetas?: string[] };

// Fold a quirks edit into what's stored. Only the keys the client sent change, so
// toggling one fix keeps learned ones (droppedBetas, modelRoutes). Flags in
// `removeDroppedBetas` are dropped from the learned list; the rest is the union,
// so a flag learned while the page was open survives.
export function mergeQuirks(
  current: { droppedBetas?: string[] } | null | undefined,
  body: { quirks?: unknown; removeDroppedBetas?: unknown },
): { quirks: NodeQuirks; removed: Set<string> } {
  const out = body.quirks === undefined ? {} : sanitizeNodeQuirks(body.quirks, { keepEmpty: true });
  const removed = new Set(Array.isArray(body.removeDroppedBetas) ? body.removeDroppedBetas.map(String) : []);
  if (out.droppedBetas || removed.size) {
    const all = [...new Set([...(current?.droppedBetas || []), ...(out.droppedBetas || [])])];
    out.droppedBetas = all.filter((f) => !removed.has(f));
  }
  return { quirks: out, removed };
}

// A key's providerSpecificData after a node edit: its own fields stay, node
// fields win, and learned beta flags from both sides are kept unless removed.
export function mergeConnectionData(
  psd: QuirkHolder = {},
  node: QuirkHolder,
  { removed = new Set<string>(), connectionFields = {} }: { removed?: Set<string>; connectionFields?: Record<string, unknown> } = {},
): QuirkHolder {
  const fromNode = Object.fromEntries(QUIRK_KEYS.filter((k) => node[k] !== undefined).map((k) => [k, node[k]]));
  const next: QuirkHolder = { ...psd, ...connectionFields, ...fromNode };
  if (psd.droppedBetas || node.droppedBetas) {
    next.droppedBetas = [...new Set([...(node.droppedBetas || []), ...(psd.droppedBetas || [])])].filter((f) => !removed.has(f));
  }
  return next;
}
