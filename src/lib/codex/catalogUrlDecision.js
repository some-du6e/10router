// Whether the Codex config the dashboard writes gets model_catalog_url.
//
// With the line, Codex 0.166+ uses only the router's catalog and looks its
// `model` up there by exact name. So it's written only for such a Codex
// (src/shared/utils/codexCatalog.js), and only when the catalog this key gets
// really lists every configured id: the routed model list, through the key's
// allowlist, the same way /backend-api/codex/models builds it. A model the key
// was allowed by a bare name is listed under that name only; an alias isn't
// listed at all (only what it points to is). Anything uncertain answers no,
// and Codex keeps its own list, as before the catalog.
import { filterModelsForRequest } from "@/sse/services/keyLimits.js";
import { getRoutedModels } from "@/lib/codex/routedModels.js";
import { codexReadsCatalogUrl } from "@/shared/utils/codexCatalog.js";

/** The ids the catalog lists for this key. */
async function listedIds(apiKey) {
  const request = { headers: new Headers(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
  const models = await filterModelsForRequest(request, await getRoutedModels());
  return new Set(models.map((model) => model.id));
}

/**
 * @param {object} options
 * @param {string|null} options.apiKey the router key the config is applied with
 * @param {string[]} options.ids the model and subagent model it sets
 * @param {number[]|null} options.codexVersion the installed Codex's version
 * @param {(apiKey: string|null) => Promise<Set<string>>} [options.listIds] for tests
 * @returns {Promise<boolean>}
 */
export async function wantsCatalogUrl({ apiKey, ids, codexVersion, listIds = listedIds }) {
  if (!codexReadsCatalogUrl(codexVersion)) return false;
  try {
    const listed = await listIds(apiKey || null);
    return ids.filter(Boolean).length > 0 && ids.filter(Boolean).every((id) => listed.has(id));
  } catch {
    return false;
  }
}
