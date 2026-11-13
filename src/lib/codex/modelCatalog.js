// The `{ "models": [...] }` catalog Codex reads from `<base_url>/models` (or a
// provider's `model_catalog_url`). Codex rejects the whole body if one entry
// fails to decode, and once a catalog decodes it replaces the one Codex ships
// with, so every entry must be complete. Field rules come from Codex's
// `ModelInfo` (codex-rs/protocol/src/openai_models.rs);
// tests/unit/codex-model-catalog.test.js pins them for 0.137 and 0.167.
import { PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import prompt from "open-sse/config/codex/prompt.json" with { type: "json" };
import bundled from "open-sse/config/codex/models.json" with { type: "json" };

// The Codex release open-sse/config/codex/ was vendored from
// (scripts/vendor-codex-catalog.mjs).
export const CODEX_CATALOG_VERSION = "0.167.2";

// Codex's generic agent prompt, the one it uses for a model it has no metadata for.
export const CODEX_BASE_INSTRUCTIONS = prompt.instructions;

// Codex's own catalog, as shipped in the release above.
export const CODEX_BUNDLED_MODELS = bundled.models;

export const CODEX_ALIAS = PROVIDER_ID_TO_ALIAS.codex;

const REASONING_LEVELS = [
  { effort: "minimal", description: "Fastest responses with limited reasoning." },
  { effort: "low", description: "Balances speed with some reasoning." },
  { effort: "medium", description: "Default reasoning depth." },
  { effort: "high", description: "Maximizes reasoning depth for complex problems." },
];

// What Codex 0.137 decodes; 0.167 takes any non-empty effort.
const LEGACY_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);

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

const parseVersion = (value) => {
  const match = typeof value === "string" ? value.match(/^(\d+)\.(\d+)\.(\d+)/) : null;
  return match ? match.slice(1).map(Number) : null;
};

const older = (a, b) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
};

const VENDORED = parseVersion(CODEX_CATALOG_VERSION);

/**
 * Codex's bundled entries as a given Codex client can use them: entries newer
 * than the client (`minimal_client_version`) are left out, the way the ChatGPT
 * backend leaves them out, and clients older than the vendored release get
 * only the reasoning efforts they can decode.
 * @param {string|null} [clientVersion] the `client_version` Codex sent
 */
export function codexModelsFor(clientVersion) {
  const client = parseVersion(clientVersion);
  const legacy = client && older(client, VENDORED);
  const usable = client
    ? CODEX_BUNDLED_MODELS.filter((m) => {
      const minimal = parseVersion(m.minimal_client_version);
      return !minimal || !older(client, minimal);
    })
    : CODEX_BUNDLED_MODELS;
  return usable.map((model) => {
    // 0.137 requires the field; with an instructions template present neither
    // version reads it, so the prompt isn't sent twice.
    const entry = { ...model, base_instructions: model.base_instructions ?? "" };
    if (!legacy) return entry;
    const levels = model.supported_reasoning_levels.filter((l) => LEGACY_EFFORTS.has(l.effort));
    const keepDefault = levels.some((l) => l.effort === model.default_reasoning_level);
    return {
      ...entry,
      supported_reasoning_levels: levels,
      default_reasoning_level: keepDefault ? model.default_reasoning_level : levels.at(-1)?.effort ?? null,
    };
  });
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
    // Defaults to true; Codex's own fallback for unknown models turns it off.
    include_apps_usage_instructions: false,
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
 * one of Codex's own entries (`codexModels`) the way Codex itself would match
 * it gets that entry under its routed id, so `cx/gpt-5.5` or `gh/gpt-5.5`
 * keeps the prompt, tools and limits Codex ships for `gpt-5.5`.
 * @param {object[]} models routed models ({ id, owned_by, capabilities? })
 * @param {object[]} [codexModels] Codex catalog entries, from codexModelsFor()
 */
export function buildCodexCatalog(models, codexModels = []) {
  return models.map((model) => {
    const native = findCodexModel(model.id, codexModels);
    if (!native) return toCodexEntry(model);
    // `upgrade` names a bare Codex model; offered on `kr/gpt-5.6-sol` it would
    // move the session to another provider.
    return { ...native, slug: model.id, display_name: model.id, visibility: "list", upgrade: null };
  });
}
