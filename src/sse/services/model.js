// Re-export from open-sse with localDb integration
import { getModelAliases, getComboByName, getProviderNodes, getProviderConnections, getSettings } from "@/lib/localDb";
import {
  parseModel as parseModelCore,
  resolveModelAliasFromMap,
  getModelInfoCore,
  stripContextWindowSuffix,
} from "open-sse/services/model.js";
import REGISTRY from "open-sse/providers/registry/index.js";

// Local provider alias overrides (HMR-friendly, applied on top of open-sse map)
const LOCAL_PROVIDER_ALIASES = {
  xmtp: "xiaomi-tokenplan",
  "xiaomi-tokenplan": "xiaomi-tokenplan",
};

const RESERVED_PROVIDER_PREFIXES = new Set(Object.keys(LOCAL_PROVIDER_ALIASES));
for (const entry of REGISTRY) {
  RESERVED_PROVIDER_PREFIXES.add(entry.id);
  if (entry.alias) RESERVED_PROVIDER_PREFIXES.add(entry.alias);
  for (const alias of entry.aliases || []) RESERVED_PROVIDER_PREFIXES.add(alias);
}

export function parseModel(modelStr) {
  const parsed = parseModelCore(modelStr);
  if (parsed?.providerAlias && LOCAL_PROVIDER_ALIASES[parsed.providerAlias]) {
    return { ...parsed, provider: LOCAL_PROVIDER_ALIASES[parsed.providerAlias] };
  }
  return parsed;
}

/**
 * Resolve model alias from localDb
 */
export async function resolveModelAlias(alias) {
  const aliases = await getModelAliases();
  return resolveModelAliasFromMap(alias, aliases);
}

/**
 * Get full model info (parse or resolve)
 */
export async function getModelInfo(modelStr) {
  const parsed = parseModel(modelStr);

  if (!parsed.isAlias) {
    // Provider-node prefixes are user-defined. They must not override built-in
    // provider ids/aliases such as `cf`, `cloudflare-ai`, `openai`, or `hf`.
    if (!RESERVED_PROVIDER_PREFIXES.has(parsed.providerAlias)) {
      const openaiNodes = await getProviderNodes({ type: "openai-compatible" });
      const matchedOpenAI = openaiNodes.find((node) => node.prefix === parsed.providerAlias);
      if (matchedOpenAI) {
        return { provider: matchedOpenAI.id, model: parsed.model };
      }

      const anthropicNodes = await getProviderNodes({ type: "anthropic-compatible" });
      const matchedAnthropic = anthropicNodes.find((node) => node.prefix === parsed.providerAlias);
      if (matchedAnthropic) {
        return { provider: matchedAnthropic.id, model: parsed.model };
      }

      const embeddingNodes = await getProviderNodes({ type: "custom-embedding" });
      const matchedEmbedding = embeddingNodes.find((node) => node.prefix === parsed.providerAlias);
      if (matchedEmbedding) {
        return { provider: matchedEmbedding.id, model: parsed.model };
      }
    }
    return {
      provider: parsed.provider,
      model: parsed.model
    };
  }

  // Check if this is a combo name before resolving as alias
  // This prevents combo names from being incorrectly routed to providers
  const combo = await getComboByName(parsed.model);
  if (combo) {
    // Return null provider to signal this should be handled as combo
    // The caller (handleChat) will detect this and handle it as combo
    return { provider: null, model: parsed.model };
  }

  const aliases = await getModelAliases();
  if (!aliases?.[parsed.model]) {
    const autoModels = await getAutoComboModels(parsed.model);
    if (autoModels.length > 1) return { provider: null, model: parsed.model };
    if (autoModels.length === 1) return getModelInfo(autoModels[0]);
  }

  return getModelInfoCore(modelStr, aliases);
}

// Bare ids ("claude-opus-5-5") match catalog ids by their last path segment,
// with dots and case ignored, so "sfff/claude-opus-5.5" and
// "openrouter/anthropic/claude-opus-5-5" both count.
function autoComboKey(modelId) {
  return String(modelId).toLowerCase().replace(/\./g, "-");
}

// How a provider is paid for, from its registry category. Auto combos skip the
// sets the user blocks, so a free model never quietly falls back to a paid one.
//   payg         pay per token with an API key (OpenAI, Anthropic, Groq, ...)
//   freeTier     free up to a limit, then paid (OpenRouter, Gemini API, ...)
//   subscription flat-rate plan you log in to (Claude Code, Codex, Copilot, ...)
//   free         no billing at all (Kiro, Gemini CLI, ...)
//   custom       an endpoint you added yourself
export const AUTO_COMBO_BILLING_SETS = ["payg", "freeTier", "subscription", "free", "custom"];
export const DEFAULT_AUTO_COMBO_BLOCKED_BILLING = ["payg", "freeTier"];

const BILLING_BY_CATEGORY = {
  apikey: "payg",
  freeTier: "freeTier",
  oauth: "subscription",
  webCookie: "subscription",
  free: "free",
};

const BILLING_BY_PROVIDER = new Map();
for (const entry of REGISTRY) {
  const billing = entry.noAuth ? "free" : BILLING_BY_CATEGORY[entry.category] || "payg";
  for (const key of [entry.id, entry.alias, ...(entry.aliases || [])]) {
    if (key) BILLING_BY_PROVIDER.set(key, billing);
  }
}

function providerBilling(providerIdOrAlias) {
  return BILLING_BY_PROVIDER.get(providerIdOrAlias) || "custom";
}

const AUTO_COMBO_CATALOG_TTL_MS = 60_000;
let autoComboCatalog = null;

function refreshModelCatalog() {
  // With nothing connected, buildModelsList returns the whole static catalog,
  // which would build combos out of providers that have no credentials.
  const models = Promise.resolve()
    .then(() => getProviderConnections())
    .then(async (conns) => {
      if (!conns.some((c) => c.isActive !== false)) return [];
      const { buildModelsList } = await import("@/app/api/v1/models/route.js");
      const list = await buildModelsList(["llm"]);
      // A connection can list its models under its own prefix, so map those
      // back to the provider before looking up its billing set.
      const prefixes = new Map();
      for (const c of conns) {
        const prefix = c.providerSpecificData?.prefix?.trim();
        if (prefix) prefixes.set(prefix, c.provider);
      }
      return list
        .filter((m) => m.owned_by !== "combo" && typeof m.id === "string" && m.id.includes("/"))
        .map((m) => {
          const prefix = m.id.slice(0, m.id.indexOf("/"));
          return { id: m.id, prefix, billing: providerBilling(prefixes.get(prefix) || prefix) };
        });
    })
    .catch(() => []);
  const entry = { models, expiresAt: Date.now() + AUTO_COMBO_CATALOG_TTL_MS };
  // Keep serving the old list until the new one lands, so an expired cache
  // never makes a request wait on live provider catalog fetches.
  models.then(() => { autoComboCatalog = entry; });
  return models;
}

async function loadModelCatalog() {
  if (!autoComboCatalog) {
    autoComboCatalog = { models: refreshModelCatalog(), expiresAt: Infinity };
    return autoComboCatalog.models;
  }
  if (autoComboCatalog.expiresAt <= Date.now()) {
    autoComboCatalog.expiresAt = Infinity;
    refreshModelCatalog();
  }
  return autoComboCatalog.models;
}

/**
 * Every connected provider/model whose model id is this bare name, in catalog
 * order. Lets a client ask for "claude-opus-5-5" and fall back across all the
 * providers serving it, with no combo set up by hand.
 */
export async function getAutoComboModels(modelStr) {
  const bare = comboLookupName(modelStr);
  if (!bare || bare.includes("/")) return [];
  const key = autoComboKey(bare);
  const [catalog, settings] = await Promise.all([loadModelCatalog(), Promise.resolve().then(() => getSettings()).catch(() => ({}))]);
  const blockedSets = new Set(settings.autoComboBlockedBilling ?? DEFAULT_AUTO_COMBO_BLOCKED_BILLING);
  const excluded = new Set(
    (settings.autoComboExcludedProviders || []).map((p) => String(p).trim().toLowerCase()),
  );
  return catalog
    .filter(({ id, prefix, billing }) => {
      if (blockedSets.has(billing) || excluded.has(prefix.toLowerCase())) return false;
      return autoComboKey(id.slice(id.lastIndexOf("/") + 1)) === key;
    })
    .map(({ id }) => id);
}

/**
 * Normalize a client model id to the name combos are stored under.
 */
export function comboLookupName(modelStr) {
  return stripContextWindowSuffix(modelStr).model;
}

/**
 * Check if model is a combo and get models list
 * @returns {Promise<string[]|null>} Array of models or null if not a combo
 */
export async function getComboModels(modelStr) {
  // Only check if it's not in provider/model format
  if (modelStr.includes("/")) return null;

  // Combos are stored under a bare name, so a client-supplied context-window
  // selector ("claude-opus-5[1m]") must come off before the lookup. getModelInfo
  // already strips it and will report the combo; without the same strip here the
  // handler's second lookup misses and the request dies as "Invalid model format".
  const combo = await getComboByName(comboLookupName(modelStr));
  if (combo && combo.models && combo.models.length > 0) {
    return combo.models;
  }
  if (combo) return null;

  // No combo by that name: build one from every provider serving the model,
  // unless the user aliased the name to one model on purpose.
  const aliases = await getModelAliases();
  if (aliases?.[comboLookupName(modelStr)]) return null;
  const autoModels = await getAutoComboModels(modelStr);
  return autoModels.length > 1 ? autoModels : null;
}
