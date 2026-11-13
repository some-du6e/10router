import { buildModelsList } from "../../models/route.js";
import { filterModelsForRequest } from "@/sse/services/keyLimits.js";
import { buildCodexCatalog } from "@/lib/codex/modelCatalog.js";
import { getCodexUpstreamModels } from "@/sse/services/codexUpstreamCatalog.js";

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
    const models = await filterModelsForRequest(request, await buildModelsList(["llm"]));
    const upstream = await getCodexUpstreamModels(new URL(request.url).searchParams.get("client_version"));
    const entries = buildCodexCatalog(models, upstream);

    // Codex looks up its own models by their bare names: a bare model in the
    // config (routed to `cx/` by the Codex ingress) and the ones it picks for
    // side requests. Once this catalog decodes it replaces the one Codex ships,
    // so those stay in, hidden from the picker.
    const listed = new Set(entries.map((entry) => entry.slug));
    const bare = await filterModelsForRequest(
      request,
      upstream.filter((model) => !listed.has(model.slug)),
      (model) => `cx/${model.slug}`,
      (model) => model,
    );

    const created = Math.floor(Date.now() / 1000);
    return Response.json(
      {
        models: [...entries, ...bare.map((model) => ({ ...model, visibility: "hide" }))],
        object: "list",
        data: entries.map((entry) => toOpenAIEntry(entry, created)),
      },
      { headers: { "Access-Control-Allow-Origin": "*" } }
    );
  } catch (error) {
    console.log("Error building codex models catalog:", error);
    return Response.json(
      { error: { message: error.message, type: "server_error" } },
      { status: 500 }
    );
  }
}
