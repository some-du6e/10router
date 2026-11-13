import { getRoutedModels } from "@/lib/codex/routedModels.js";
import { getCatalogStamp } from "open-sse/providers/catalogOverride.js";
import { filterModelsForRequest } from "@/sse/services/keyLimits.js";
import { buildCodexCatalog, codexShapeFor, codexModelsForShape, uniqueBySlug, CODEX_ALIAS } from "@/lib/codex/modelCatalog.js";

// Codex clients pointed at a `/backend-api/codex` base URL fetch their catalog
// from `<base_url>/models` and expect the Codex shape (`{ "models": [...] }`).
// Serve both shapes in one body: `models` for Codex, `data` for anything else
// that follows the OpenAI list contract.

function toOpenAIEntry(entry, created) {
  return {
    id: entry.slug,
    object: "model",
    created,
    owned_by: "10router",
    metadata: {
      display_name: entry.display_name,
      description: entry.description,
      context_window: entry.context_window,
      max_output_tokens: entry.max_output_tokens ?? null,
      input_modalities: entry.input_modalities,
      supported_reasoning_levels: entry.supported_reasoning_levels,
      default_reasoning_level: entry.default_reasoning_level,
      supports_reasoning_summaries: entry.supports_reasoning_summaries,
      supports_parallel_tool_calls: entry.supports_parallel_tool_calls,
      supported_in_api: true,
      priority: 0,
    },
  };
}

// Most generic entries carry the same 21k-character prompt, so the body runs
// to megabytes. Codex asks for it again every few minutes with the same
// models, so keep the last serialized body (one slot) and reuse it while its
// inputs are the same. The entries themselves are rebuilt on every request.
let lastBody = { key: null, models: null, data: null };

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
 * GET /backend-api/codex/models - Codex-native model catalog
 */
export async function GET(request) {
  try {
    // A key with a model allowlist sees only the models it may use.
    // Cached and bounded in time (see routedModels.js); the key's allowlist applies after.
    const models = await filterModelsForRequest(request, await getRoutedModels());
    const shape = codexShapeFor(new URL(request.url).searchParams.get("client_version"));
    const codexModels = codexModelsForShape(shape);
    const entries = buildCodexCatalog(models, codexModels);

    // Codex looks up its own models by their bare names: a bare model in the
    // config (routed to `cx/` by the Codex ingress) and the ones it picks for
    // side requests. Once this catalog decodes it replaces the one Codex ships,
    // so those stay in, hidden from the picker.
    const listed = new Set(entries.map((entry) => entry.slug));
    const bare = await filterModelsForRequest(
      request,
      codexModels.filter((model) => !listed.has(model.slug)),
      (model) => `${CODEX_ALIAS}/${model.slug}`,
      (model) => model,
    );

    // Keyed on what shapes the body, not the raw client_version, so any number
    // of version strings that shape it the same way share one build.
    // getCatalogStamp: generic entries read capabilities from the synced
    // models.dev catalog for models that carry none of their own.
    const key = JSON.stringify([shape, getCatalogStamp(), models, bare.map((model) => model.slug)]);
    if (lastBody.key !== key) {
      const created = Math.floor(Date.now() / 1000);
      const routed = uniqueBySlug(entries);
      lastBody = {
        key,
        models: JSON.stringify(uniqueBySlug([...routed, ...bare.map((model) => ({ ...model, visibility: "hide" }))])),
        data: JSON.stringify(routed.map((entry) => toOpenAIEntry(entry, created))),
      };
    }
    return new Response(`{"models":${lastBody.models},"object":"list","data":${lastBody.data}}`, {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  } catch (error) {
    console.log("Error building codex models catalog:", error);
    return Response.json(
      { error: { message: error.message, type: "server_error" } },
      { status: 500 }
    );
  }
}
