// The `{ "models": [...] }` catalog Codex reads from `<base_url>/models` (or a
// provider's `model_catalog_url`). Codex rejects the whole body if one entry
// fails to decode, and once a catalog decodes it can stand in for the metadata
// Codex ships with, so every entry must be complete. Field rules come from
// Codex's `ModelInfo` (codex-rs/protocol/src/openai_models.rs);
// tests/unit/codex-model-catalog.test.js pins them for 0.137 and 0.167.
import { PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import baseInstructions from "./baseInstructions.json" with { type: "json" };

// Codex's generic agent prompt, the one it uses for a model it has no metadata for.
export const CODEX_BASE_INSTRUCTIONS = baseInstructions.instructions;

const REASONING_LEVELS = [
  { effort: "minimal", description: "Fastest responses with limited reasoning." },
  { effort: "low", description: "Balances speed with some reasoning." },
  { effort: "medium", description: "Default reasoning depth." },
  { effort: "high", description: "Maximizes reasoning depth for complex problems." },
];

// Spelled the way Codex's own catalog spells it: 0.137 reads it as the
// `shell_command` tool, 0.167 as an alias of `unified_exec`.
const SHELL_TOOL = "shell_command";

const truncationPolicyFor = (slug) => (
  slug.endsWith("/gpt-5.2") || slug === "gpt-5.2"
    ? { mode: "bytes", limit: 10000 }
    : { mode: "tokens", limit: 10000 }
);

const ALIAS_TO_PROVIDER_ID = Object.fromEntries(
  Object.entries(PROVIDER_ID_TO_ALIAS).map(([id, alias]) => [alias, id])
);

// "cx/gpt-5.6-sol" -> capabilities for provider `codex`, model `gpt-5.6-sol`.
// Combos and unprefixed ids fall back to the capability defaults.
function capabilitiesFor(modelId) {
  const slash = modelId.indexOf("/");
  if (slash === -1) return getCapabilitiesForModel(null, modelId);
  const alias = modelId.slice(0, slash);
  const bareId = modelId.slice(slash + 1);
  return getCapabilitiesForModel(ALIAS_TO_PROVIDER_ID[alias] || alias, bareId);
}

function inputModalities(caps) {
  const modalities = ["text"];
  if (caps?.vision) modalities.push("image");
  return modalities;
}

function longestSlugPrefix(id, candidates) {
  let best = null;
  for (const candidate of candidates) {
    if (typeof candidate?.slug !== "string" || !id.startsWith(candidate.slug)) continue;
    if (!best || candidate.slug.length > best.slug.length) best = candidate;
  }
  return best;
}

// Codex's own metadata lookup (find_model_from_candidates in
// codex-rs/models-manager/src/manager.rs): the longest slug that prefixes the
// id, else the same match on what follows a single `namespace/`.
export function findCodexModel(id, candidates) {
  if (typeof id !== "string" || !Array.isArray(candidates) || candidates.length === 0) return null;
  const direct = longestSlugPrefix(id, candidates);
  if (direct) return direct;
  const slash = id.indexOf("/");
  if (slash <= 0) return null;
  const namespace = id.slice(0, slash);
  const suffix = id.slice(slash + 1);
  if (suffix.includes("/") || !/^[A-Za-z0-9_-]+$/.test(namespace)) return null;
  return longestSlugPrefix(suffix, candidates);
}

// A routed model Codex has no metadata of its own for.
export function toCodexEntry(model) {
  const caps = model.capabilities?.contextWindow ? model.capabilities : capabilitiesFor(model.id);
  const reasoning = caps?.reasoning === true;
  const tools = caps?.tools !== false;
  return {
    slug: model.id,
    display_name: model.id,
    description: `${model.owned_by || "10router"} via 10router`,
    base_instructions: CODEX_BASE_INSTRUCTIONS,
    default_reasoning_level: reasoning ? "medium" : null,
    supported_reasoning_levels: reasoning ? REASONING_LEVELS : [],
    shell_type: tools ? SHELL_TOOL : "disabled",
    apply_patch_tool_type: tools ? "freeform" : null,
    web_search_tool_type: "text",
    supported_in_api: true,
    priority: 0,
    minimal_client_version: null,
    availability_nux: null,
    upgrade: null,
    supports_reasoning_summaries: reasoning,
    support_verbosity: false,
    default_verbosity: null,
    supports_parallel_tool_calls: tools,
    context_window: caps?.contextWindow || 200000,
    max_output_tokens: caps?.maxOutput || undefined,
    input_modalities: inputModalities(caps),
    available_in_plans: [],
    prefer_websockets: false,
    visibility: "list",
    truncation_policy: truncationPolicyFor(model.id),
    experimental_supported_tools: [],
  };
}

/**
 * Codex catalog entries for the routed models, in order. A model that matches
 * an entry of Codex's own catalog (`upstream`, as the ChatGPT backend serves
 * it) the way Codex itself would match it gets that entry under its routed
 * id, so ChatGPT-backed models keep their real prompt, tools and limits.
 * @param {object[]} models routed models ({ id, owned_by, capabilities? })
 * @param {object[]} [upstream] Codex catalog entries from the ChatGPT backend
 */
export function buildCodexCatalog(models, upstream = []) {
  return models.map((model) => {
    const native = findCodexModel(model.id, upstream);
    if (!native) return toCodexEntry(model);
    return { ...native, slug: model.id, display_name: model.id, visibility: "list" };
  });
}
