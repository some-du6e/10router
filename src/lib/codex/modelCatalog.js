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

// Label for the Codex release tag (rust-v<this>) that open-sse/config/codex/
// was vendored from. scripts/vendor-codex-catalog.mjs rewrites it, and
// tests/unit/codex-model-catalog.test.js checks it against the vendored files.
// Nothing derives version rules from it.
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

// Before 0.138.0 a reasoning effort had to be one of these; from 0.138.0 any
// other non-empty string decodes as a custom effort.
const STRICT_EFFORTS_BEFORE = [0, 138, 0];
const STRICT_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);

// Codex up to 0.146 requires a `base_instructions` string, and falls back to
// it when `[features] personality = false` clears the entry's template
// (with_config_overrides in models-manager/src/model_info.rs). So clients
// before 0.147.0 get the template's own text there, the way Codex 0.167's
// serialize_model_infos_with_legacy_base writes it. From 0.147.0 the field is
// optional and the template is kept, so the rest get "": still accepted by the
// 0.147.0 alphas, which report 0.147.0 too.
const FULL_BASE_INSTRUCTIONS_BEFORE = [0, 147, 0];
const NATIVE_MODELS = bundled.models.map((model) => ({ ...model, base_instructions: model.base_instructions ?? "" }));

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

// A source build of Codex reports its workspace version, 0.0.0: newest, not oldest.
const parseVersion = (value) => {
  const match = typeof value === "string" ? value.match(/^(\d+)\.(\d+)\.(\d+)/) : null;
  const version = match ? match.slice(1).map(Number) : null;
  return version && version.some((n) => n > 0) ? version : null;
};

const older = (a, b) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
};

/**
 * How a given Codex client gets Codex's bundled entries: which ones it can
 * use (an entry newer than the client, by `minimal_client_version`, is left
 * out the way the ChatGPT backend leaves it out) and whether it needs the
 * strict reasoning efforts and the prompt in `base_instructions`. A missing,
 * 0.0.0 or unreadable version means the newest Codex. Two versions with the
 * same shape get the same entries.
 * @param {string|null} [clientVersion] the `client_version` Codex sent
 * @returns {{ strictEfforts: boolean, fullBaseInstructions: boolean, slugs: string[] }}
 */
export function codexShapeFor(clientVersion) {
  const client = parseVersion(clientVersion);
  const slugs = NATIVE_MODELS
    .filter((m) => {
      const minimal = parseVersion(m.minimal_client_version);
      return !client || !minimal || !older(client, minimal);
    })
    .map((m) => m.slug);
  return {
    strictEfforts: Boolean(client) && older(client, STRICT_EFFORTS_BEFORE),
    fullBaseInstructions: Boolean(client) && older(client, FULL_BASE_INSTRUCTIONS_BEFORE),
    slugs,
  };
}

/**
 * Codex's bundled entries, shaped for one client (see codexShapeFor).
 * @param {{ strictEfforts: boolean, fullBaseInstructions: boolean, slugs: string[] }} shape
 */
export function codexModelsForShape({ strictEfforts, fullBaseInstructions, slugs }) {
  const usable = NATIVE_MODELS.filter((m) => slugs.includes(m.slug));
  return usable.map((model) => {
    let entry = model;
    if (fullBaseInstructions) {
      entry = { ...entry, base_instructions: entry.model_messages?.instructions_template ?? entry.base_instructions };
    }
    if (strictEfforts) {
      const levels = entry.supported_reasoning_levels.filter((l) => STRICT_EFFORTS.has(l.effort));
      const keepDefault = levels.some((l) => l.effort === entry.default_reasoning_level);
      entry = {
        ...entry,
        supported_reasoning_levels: levels,
        default_reasoning_level: keepDefault ? entry.default_reasoning_level : levels.at(-1)?.effort ?? null,
      };
    }
    return entry;
  });
}

export const codexModelsFor = (clientVersion) => codexModelsForShape(codexShapeFor(clientVersion));

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

// Codex refuses a whole catalog with a repeated or empty slug
// (model-provider/src/models_endpoint.rs). The first entry for a slug wins.
export function uniqueBySlug(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    const slug = typeof entry?.slug === "string" ? entry.slug.trim() : "";
    if (!slug || seen.has(entry.slug)) return false;
    seen.add(entry.slug);
    return true;
  });
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
