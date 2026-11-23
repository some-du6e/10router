import { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS, getModelKind } from "@/shared/constants/models";
import {
  AI_PROVIDERS,
  getProviderAlias,
  isAnthropicCompatibleProvider,
  isOpenAICompatibleProvider,
} from "@/shared/constants/providers";
import { getProviderConnections, getCombos, getCustomModels, getModelAliases } from "@/lib/localDb";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { resolveKiroModels } from "open-sse/services/kiroModels.js";
import { resolveKimchiModels } from "open-sse/services/kimchiModels.js";
import { resolveQoderModels } from "open-sse/services/qoderModels.js";
import { resolveCopilotModels } from "open-sse/services/copilotModels.js";
import { resolveClinepassModels } from "open-sse/services/clinepassModels.js";
import { resolveGrokCliModels } from "open-sse/services/grokCliModels.js";
import { resolveCursorModels } from "open-sse/services/cursorModels.js";
import { resolveZedModels } from "open-sse/shared/zedAuth.js";
import { updateProviderCredentials } from "@/sse/services/tokenRefresh";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { toProxyOptions } from "@/lib/network/proxyRouting";
import { capabilitiesFromServiceKind, getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { filterModelsForRequest } from "@/sse/services/keyLimits.js";

// The longest one provider's live catalog may take. Past it the list uses that
// provider's static models, so one hung upstream can't stall the whole list
// (and with it the auto-combo catalog requests wait on after a restart).
export const LIVE_CATALOG_TIMEOUT_MS = 8000;

// Per-provider live model resolvers. Each receives a connection record and an
// abort signal that fires when its time is up (for fetches of its own; a fetch
// it shares with other callers must not take it), and returns
// { models: [{ id, name? }, ...] } | null on failure.
// Adding a provider here makes /v1/models prefer the live catalog for it.
const LIVE_MODEL_RESOLVERS = {
  kiro: async (conn) => {
    const result = await resolveKiroModels({
      accessToken: conn.accessToken,
      refreshToken: conn.refreshToken,
      providerSpecificData: conn.providerSpecificData || {}
    }, {
      log: console,
      onCredentialsRefreshed: (refreshed) => updateProviderCredentials(conn.id, refreshed),
    });
    return result?.models?.length ? { models: result.models } : null;
  },
  qoder: async (conn) => {
    const result = await resolveQoderModels({
      accessToken: conn.accessToken,
      refreshToken: conn.refreshToken,
      email: conn.email,
      displayName: conn.displayName,
      providerSpecificData: conn.providerSpecificData || {}
    });
    if (!result?.models?.length) return null;
    return {
      models: result.models.map((m) => ({ id: m.id, name: m.name })),
    };
  },
  kimchi: async (conn) => {
    const result = await resolveKimchiModels({
      accessToken: conn.accessToken,
      apiKey: conn.apiKey,
      providerSpecificData: conn.providerSpecificData || {}
    }, { log: console });
    return result?.models?.length ? { models: result.models } : null;
  },
  github: async (conn) => {
    const result = await resolveCopilotModels({
      accessToken: conn.accessToken,
      refreshToken: conn.refreshToken,
      providerSpecificData: conn.providerSpecificData || {}
    }, {
      log: console,
      onCredentialsRefreshed: async (refreshed) => {
        await updateProviderCredentials(conn.id, {
          copilotToken: refreshed.copilotToken,
          copilotTokenExpiresAt: refreshed.copilotTokenExpiresAt,
        });
      },
    });
    return result?.models?.length ? { models: result.models } : null;
  },
  clinepass: async (conn) => {
    const result = await resolveClinepassModels({
      accessToken: conn.accessToken,
      apiKey: conn.apiKey,
    });
    return result?.models?.length ? { models: result.models } : null;
  },
  "grok-cli": async (conn, signal) => {
    const proxy = await resolveConnectionProxyConfig(conn.providerSpecificData || {}, conn.provider);
    const result = await resolveGrokCliModels({
      ...conn,
      connectionId: conn.id,
    }, {
      log: console,
      signal,
      proxyOptions: toProxyOptions(proxy),
      onCredentialsRefreshed: async (refreshed) => {
        await updateProviderCredentials(conn.id, refreshed);
      },
    });
    return result?.models?.length ? { models: result.models } : null;
  },
  cursor: async (conn) => {
    const result = await resolveCursorModels({
      accessToken: conn.accessToken,
      providerSpecificData: conn.providerSpecificData || {},
    }, { log: console });
    return result?.models?.length ? { models: result.models } : null;
  },
  // No signal: resolveZedModels shares one in-flight /models fetch with chat
  // requests, so aborting it here would fail theirs too. The timeout still
  // cuts the list loose from it.
  zed: async (conn) => {
    const result = await resolveZedModels({
      accessToken: conn.accessToken,
      providerSpecificData: conn.providerSpecificData || {},
    });
    if (!result?.models?.length) return null;
    return {
      models: result.models
        .filter((m) => !m.isDisabled)
        .map((m) => ({
          id: m.id,
          name: m.name,
          capabilities: m.supportsTools ? { tools: true } : undefined,
        })),
    };
  },
};

/**
 * Run one live resolver with LIVE_CATALOG_TIMEOUT_MS to finish. It gets an
 * abort signal to stop its own fetches; one that ignores the signal is still
 * cut off here, and the caller falls back to the static list.
 */
export class LiveCatalogTimeoutError extends Error {
  constructor(providerId, timeoutMs) {
    super(`${providerId} model list timed out after ${timeoutMs} ms`);
    this.name = "LiveCatalogTimeoutError";
    this.providerId = providerId;
  }
}

export async function withLiveCatalogTimeout(providerId, run, timeoutMs = LIVE_CATALOG_TIMEOUT_MS) {
  const controller = new AbortController();
  let timer;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new LiveCatalogTimeoutError(providerId, timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => run(controller.signal)), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

const parseOpenAIStyleModels = (data) => {
  if (Array.isArray(data)) return data;
  return data?.data || data?.models || data?.results || [];
};

// Header sent by fetchCompatibleModelIds to detect cross-instance /models fetches
// and break recursive loops between 10router instances connected to each other.
const INTERNAL_MODELS_FETCH_HEADER = "x-9r-internal-models-fetch";

// LLM kind sentinel — combos/models with no explicit kind default to LLM
const LLM_KIND = "llm";

// Map per-model `type` field (in PROVIDER_MODELS) to service kind.
// Models without `type` are treated as LLM.
const MODEL_TYPE_TO_KIND = {
  image: "image",
  tts: "tts",
  embedding: "embedding",
  stt: "stt",
  imageToText: "imageToText",
  video: "video",
};

function modelKind(model) {
  const k = model?.kind || model?.type;
  if (!k) return LLM_KIND;
  return MODEL_TYPE_TO_KIND[k] || LLM_KIND;
}

// For dynamic/unknown model IDs (compatible providers, alias map, custom models)
// fall back to provider-level kind matching when per-model type is unavailable.
function inferKindFromUnknownModelId(modelId) {
  const lower = String(modelId).toLowerCase();
  if (/embed/.test(lower)) return "embedding";
  if (/tts|speech|audio|voice/.test(lower)) return "tts";
  if (/image|imagen|dall-?e|flux|sdxl|sd-|stable-diffusion/.test(lower)) return "image";
  return LLM_KIND;
}

async function fetchCompatibleModelIds(connection) {
  if (!connection?.apiKey) return [];

  const baseUrl = typeof connection?.providerSpecificData?.baseUrl === "string"
    ? connection.providerSpecificData.baseUrl.trim().replace(/\/$/, "")
    : "";

  if (!baseUrl) return [];

  let url = `${baseUrl}/models`;
  const headers = {
    "Content-Type": "application/json",
  };

  if (isOpenAICompatibleProvider(connection.provider)) {
    headers.Authorization = `Bearer ${connection.apiKey}`;
  } else if (isAnthropicCompatibleProvider(connection.provider)) {
    if (url.endsWith("/messages/models")) {
      url = url.slice(0, -9);
    } else if (url.endsWith("/messages")) {
      url = `${url.slice(0, -9)}/models`;
    }
    headers["x-api-key"] = connection.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    headers.Authorization = `Bearer ${connection.apiKey}`;
  } else {
    return [];
  }

  try {
    const controller = new AbortController();
    // Armed until the body is read: a body that stalls after its headers
    // would otherwise hold up the whole model list.
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    let data;
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { ...headers, [INTERNAL_MODELS_FETCH_HEADER]: "1" },
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) return [];
      data = await response.json();
    } finally {
      clearTimeout(timeoutId);
    }
    const rawModels = parseOpenAIStyleModels(data);

    return Array.from(
      new Set(
        rawModels
          .map((model) => model?.id || model?.name || model?.model)
          .filter((modelId) => typeof modelId === "string" && modelId.trim() !== "")
      )
    );
  } catch {
    return [];
  }
}

// Provider matches kindFilter when its serviceKinds intersect the requested kinds.
// LLM is the default kind for providers missing serviceKinds.
function providerMatchesKinds(providerId, kindFilter) {
  const provider = AI_PROVIDERS[providerId];
  const kinds = Array.isArray(provider?.serviceKinds) && provider.serviceKinds.length > 0
    ? provider.serviceKinds
    : [LLM_KIND];
  return kindFilter.some((k) => kinds.includes(k));
}

// Combo matches kindFilter when its `kind` field is in the list.
// Combos with no kind are treated as LLM.
function comboMatchesKinds(combo, kindFilter) {
  const kind = combo?.kind || LLM_KIND;
  return kindFilter.includes(kind);
}

// A provider's ids before any live lookup: the connection's chosen models,
// else the static table.
function staticModelIds(conn, providerModels) {
  const enabledModels = conn?.providerSpecificData?.enabledModels;
  const hasExplicitEnabledModels = Array.isArray(enabledModels) && enabledModels.length > 0;
  const rawModelIds = hasExplicitEnabledModels
    ? Array.from(new Set(enabledModels.filter((modelId) => typeof modelId === "string" && modelId.trim() !== "")))
    : providerModels.map((model) => model.id);
  return { rawModelIds, hasExplicitEnabledModels, liveModelKindById: new Map(), liveCapabilitiesById: new Map() };
}

// The prefix a provider's model ids are listed under: the connection's own
// prefix, else the provider's alias.
function outputAliasFor(providerId, conn) {
  const staticAlias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;
  return (conn?.providerSpecificData?.prefix || getProviderAlias(providerId) || staticAlias).trim();
}

/**
 * One provider's model ids, with what its live catalog says about them. A
 * compatible endpoint with no models listed is asked for its /models (5 s); a
 * provider with a live catalog (Kiro's per-account variants, Zed, ...) is
 * asked for that (LIVE_CATALOG_TIMEOUT_MS). Either failing leaves the static
 * ids; a live catalog that timed out is reported to `onLiveTimeout`.
 */
async function resolveProviderModelIds(providerId, conn, { skipDynamicFetch, skipLiveCatalogs, onLiveTimeout }) {
  const staticAlias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;
  const result = staticModelIds(conn, PROVIDER_MODELS[staticAlias] || []);
  const isCompatibleProvider = isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId);

  if (isCompatibleProvider && result.rawModelIds.length === 0 && !skipDynamicFetch) {
    result.rawModelIds = await fetchCompatibleModelIds(conn);
  }

  // Config-driven live catalog override (e.g. Kiro returns dynamic
  // -thinking/-agentic variants per account). On failure, fall back to
  // whatever rawModelIds already holds.
  const liveResolver = LIVE_MODEL_RESOLVERS[providerId];
  if (liveResolver && !result.hasExplicitEnabledModels && !skipLiveCatalogs) {
    try {
      const live = await withLiveCatalogTimeout(providerId, (signal) => liveResolver(conn, signal));
      if (live?.models?.length) {
        result.rawModelIds = live.models.map((m) => m.id);
        result.liveModelKindById = new Map(live.models.filter((m) => m?.id).map((m) => [m.id, modelKind(m)]));
        result.liveCapabilitiesById = new Map(live.models.filter((m) => m?.id && m.capabilities).map((m) => [m.id, m.capabilities]));
      }
    } catch (err) {
      if (err instanceof LiveCatalogTimeoutError) onLiveTimeout?.(providerId, { alias: outputAliasFor(providerId, conn) });
      console.log(`Live model fetch failed for ${providerId}: ${err?.message || err}`);
    }
  }
  return result;
}

/**
 * Build OpenAI-format models list filtered by service kinds.
 * @param {string[]} kindFilter - List of service kinds to include (e.g. ["llm"], ["webSearch","webFetch"]).
 * @param {object} [options] - skipDynamicFetch, skipLiveCatalogs, and
 *   onLiveTimeout(providerId, { alias }), told when a provider's live catalog
 *   timed out and its static models stood in; `alias` is the prefix its ids
 *   are listed under.
 */
export async function buildModelsList(kindFilter, options = {}) {
  // When this header is present, the /v1/models request came from another
  // 10router instance's fetchCompatibleModelIds — skip dynamic fetch to break
  // cross-instance recursive loops.
  const skipDynamicFetch = options.skipDynamicFetch === true;
  // Static lists only, no live provider catalogs: for callers that can't wait.
  const skipLiveCatalogs = options.skipLiveCatalogs === true;
  let connections = [];
  try {
    connections = await getProviderConnections();
    connections = connections.filter(c => c.isActive !== false);
  } catch (e) {
    console.log("Could not fetch providers, returning all models");
  }

  let combos = [];
  try {
    combos = await getCombos();
  } catch (e) {
    console.log("Could not fetch combos");
  }

  let customModels = [];
  try {
    customModels = await getCustomModels();
  } catch (e) {
    console.log("Could not fetch custom models");
  }

  let modelAliases = {};
  try {
    modelAliases = await getModelAliases();
  } catch (e) {
    console.log("Could not fetch model aliases");
  }

  let disabledByAlias = {};
  try {
    disabledByAlias = await getDisabledModels();
  } catch (e) {
    console.log("Could not fetch disabled models");
  }
  const isDisabled = (alias, modelId) => Array.isArray(disabledByAlias[alias]) && disabledByAlias[alias].includes(modelId);

  const activeConnectionByProvider = new Map();
  for (const conn of connections) {
    if (!activeConnectionByProvider.has(conn.provider)) {
      activeConnectionByProvider.set(conn.provider, conn);
    }
  }

  const models = [];

  // Combos first (filtered by kind). Web combos expose `kind` so AI knows search vs fetch.
  for (const combo of combos) {
    if (!comboMatchesKinds(combo, kindFilter)) continue;
    const entry = {
      id: combo.name,
      object: "model",
      owned_by: "combo",
    };
    if (combo.kind === "webSearch" || combo.kind === "webFetch") {
      entry.kind = combo.kind;
    }
    models.push(entry);
  }

  if (connections.length === 0) {
    // DB unavailable -> return static models, filtered by per-model kind
    const aliasToProviderId = Object.fromEntries(
      Object.entries(PROVIDER_ID_TO_ALIAS).map(([id, alias]) => [alias, id])
    );
    for (const [alias, providerModels] of Object.entries(PROVIDER_MODELS)) {
      const providerId = aliasToProviderId[alias] || alias;
      if (!providerMatchesKinds(providerId, kindFilter)) continue;
      for (const model of providerModels) {
        if (!kindFilter.includes(modelKind(model))) continue;
        if (isDisabled(alias, model.id)) continue;
        models.push({
          id: `${alias}/${model.id}`,
          object: "model",
          owned_by: alias,
        });
      }
    }

    for (const customModel of customModels) {
      if (!customModel?.id || (customModel.type && customModel.type !== "llm")) continue;
      // Custom models without active connection are LLM-only by current schema
      if (!kindFilter.includes(LLM_KIND)) continue;
      const providerAlias = customModel.providerAlias;
      if (!providerAlias) continue;

      const modelId = String(customModel.id).trim();
      if (!modelId) continue;

      models.push({
        id: `${providerAlias}/${modelId}`,
        object: "model",
        owned_by: providerAlias,
      });
    }
  } else {
    // Each provider's model ids are fetched at once, in parallel, so the whole
    // list takes as long as its slowest provider (each capped), not their sum.
    const providers = [...activeConnectionByProvider.entries()]
      .filter(([providerId]) => providerMatchesKinds(providerId, kindFilter));
    const resolved = await Promise.allSettled(providers.map(([providerId, conn]) =>
      resolveProviderModelIds(providerId, conn, { skipDynamicFetch, skipLiveCatalogs, onLiveTimeout: options.onLiveTimeout })));

    for (const [index, [providerId, conn]] of providers.entries()) {
      const staticAlias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;
      const outputAlias = outputAliasFor(providerId, conn);
      const providerModels = PROVIDER_MODELS[staticAlias] || [];

      // Build kind lookup for static models so we can filter even when only IDs are exposed
      const staticModelKindById = new Map(
        providerModels.map((m) => [m.id, modelKind(m)])
      );
      const outcome = resolved[index];
      const { rawModelIds, liveModelKindById, liveCapabilitiesById } = outcome.status === "fulfilled"
        ? outcome.value
        : staticModelIds(conn, providerModels);

      const modelIds = rawModelIds
        .map((modelId) => {
          if (modelId.startsWith(`${outputAlias}/`)) {
            return modelId.slice(outputAlias.length + 1);
          }
          if (modelId.startsWith(`${staticAlias}/`)) {
            return modelId.slice(staticAlias.length + 1);
          }
          if (modelId.startsWith(`${providerId}/`)) {
            return modelId.slice(providerId.length + 1);
          }
          return modelId;
        })
        .filter((modelId) => typeof modelId === "string" && modelId.trim() !== "");

      const customModelKindById = new Map();
      const customModelIds = customModels
        .filter((m) => {
          if (!m?.id) return false;
          const kind = getModelKind(m) || LLM_KIND;
          // imageToText custom models are vision-capable chat models: expose them
          // both in the default LLM list and in /v1/models/image-to-text.
          if (!kindFilter.includes(kind) && !(kind === "imageToText" && kindFilter.includes(LLM_KIND))) return false;
          const alias = m.providerAlias;
          return alias === staticAlias || alias === outputAlias || alias === providerId;
        })
        .map((m) => {
          const modelId = String(m.id).trim();
          if (modelId) customModelKindById.set(modelId, getModelKind(m) || LLM_KIND);
          return modelId;
        })
        .filter((modelId) => modelId !== "");

      const aliasModelIds = Object.values(modelAliases || {})
        .filter((fullModel) => {
          if (typeof fullModel !== "string" || !fullModel.includes("/")) return false;
          return (
            fullModel.startsWith(`${outputAlias}/`) ||
            fullModel.startsWith(`${staticAlias}/`) ||
            fullModel.startsWith(`${providerId}/`)
          );
        })
        .map((fullModel) => {
          if (fullModel.startsWith(`${outputAlias}/`)) {
            return fullModel.slice(outputAlias.length + 1);
          }
          if (fullModel.startsWith(`${staticAlias}/`)) {
            return fullModel.slice(staticAlias.length + 1);
          }
          if (fullModel.startsWith(`${providerId}/`)) {
            return fullModel.slice(providerId.length + 1);
          }
          return fullModel;
        })
        .filter((modelId) => typeof modelId === "string" && modelId.trim() !== "");

      const mergedModelIds = Array.from(new Set([...modelIds, ...customModelIds, ...aliasModelIds]));

      for (const modelId of mergedModelIds) {
        // Resolve kind: prefer custom/live metadata, then static, then ID heuristics.
        const customKind = customModelKindById.get(modelId);
        const liveKind = liveModelKindById.get(modelId);
        const kind = customKind || liveKind || staticModelKindById.get(modelId) || inferKindFromUnknownModelId(modelId);
        // imageToText custom models stay in the LLM list (vision-capable chat models)
        const allowAsLlm = kind === "imageToText" && kindFilter.includes(LLM_KIND);
        if (!kindFilter.includes(kind) && !allowAsLlm) continue;
        if (isDisabled(outputAlias, modelId) || isDisabled(staticAlias, modelId)) continue;

        const model = {
          id: `${outputAlias}/${modelId}`,
          object: "model",
          owned_by: outputAlias,
        };
        // Live-catalog resolvers (kiro/qoder/github/clinepass) mostly only return
        // { id, name } — no per-model capability data. Fall back to the same
        // pattern-matched capabilities the dashboard uses (useModelCaps.js) so
        // dynamically-discovered LLM models still surface vision/reasoning/search/tools.
        const caps = liveCapabilitiesById.get(modelId)
          || capabilitiesFromServiceKind(customKind || liveKind)
          || (kind === LLM_KIND ? getCapabilitiesForModel(providerId, modelId) : null);
        if (caps) model.capabilities = caps;
        // Token limits under the snake_case names the OpenAI/OpenRouter
        // convention uses. `capabilities.contextWindow` is camelCase and nested,
        // so clients matching context_length find nothing, fall back to guessing
        // the window from the model name, and guess high — a 372k model read as
        // 1.05M never reaches its compaction threshold and hard-fails upstream.
        // Emitted at top level because not every client recurses into nested
        // objects; the camelCase `capabilities` block stays for compatibility.
        if (kind === LLM_KIND || allowAsLlm) {
          let contextWindow = caps?.contextWindow;
          let maxOutput = caps?.maxOutput;
          // Live-catalog and service-kind capabilities are usually partial
          // (often just { tools: true }), so fill the gaps from the static
          // table rather than emitting null and leaving clients to guess.
          if (!Number.isFinite(contextWindow) || !Number.isFinite(maxOutput)) {
            const fallback = getCapabilitiesForModel(providerId, modelId);
            if (!Number.isFinite(contextWindow)) contextWindow = fallback.contextWindow;
            if (!Number.isFinite(maxOutput)) maxOutput = fallback.maxOutput;
          }
          if (Number.isFinite(contextWindow)) model.context_length = contextWindow;
          if (Number.isFinite(maxOutput)) model.max_completion_tokens = maxOutput;
        }
        models.push(model);
      }

      // Web search/fetch — provider IS the model, expose as {alias}/search and/or {alias}/fetch with explicit kind
      const providerInfo = AI_PROVIDERS[providerId];
      if (kindFilter.includes("webSearch") && providerInfo?.searchConfig) {
        models.push({
          id: `${outputAlias}/search`,
          object: "model",
          kind: "webSearch",
          owned_by: outputAlias,
        });
      }
      if (kindFilter.includes("webFetch") && providerInfo?.fetchConfig) {
        models.push({
          id: `${outputAlias}/fetch`,
          object: "model",
          kind: "webFetch",
          owned_by: outputAlias,
        });
      }
    }
  }

  const dedupedModels = [];
  const seenModelIds = new Set();
  for (const model of models) {
    if (!model?.id || seenModelIds.has(model.id)) continue;
    seenModelIds.add(model.id);
    dedupedModels.push(model);
  }

  return dedupedModels;
}

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * GET /v1/models - OpenAI compatible models list (LLM/chat models only by default).
 * For other capabilities use /v1/models/{kind} (image, tts, stt, embedding, image-to-text, web).
 */
export async function GET(request) {
  try {
    // Detect cross-instance recursive /models fetch (another 10router fetching our /models)
    const skipDynamicFetch = request?.headers?.get(INTERNAL_MODELS_FETCH_HEADER) === "1";
    // A key with a model allowlist sees only the models it may use.
    const data = await filterModelsForRequest(request, await buildModelsList([LLM_KIND], { skipDynamicFetch }));
    return Response.json({ object: "list", data }, {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  } catch (error) {
    console.log("Error fetching models:", error);
    return Response.json(
      { error: { message: error.message, type: "server_error" } },
      { status: 500 }
    );
  }
}
