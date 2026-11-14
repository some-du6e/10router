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
import { getRoutedModels, getFreshRoutedModels, routedModelsBehind } from "@/lib/codex/routedModels.js";
import { codexReadsCatalogUrl } from "@/shared/utils/codexCatalog.js";

// How long Apply waits for a model list that reflects a provider just added.
export const FRESH_LIST_WAIT_MS = 10_000;

/**
 * The ids the catalog lists for this key.
 * @param {string|null} apiKey
 * @param {{ fresh?: boolean }} [options] fresh: wait for a build that reflects recent writes
 */
export async function listedIds(apiKey, { fresh = false } = {}) {
  const request = { headers: new Headers(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
  const routed = fresh ? await getFreshRoutedModels(FRESH_LIST_WAIT_MS) : await getRoutedModels();
  const models = await filterModelsForRequest(request, routed);
  return new Set(models.map((model) => model.id));
}

/**
 * @param {object} options
 * @param {string|null} options.apiKey the router key the config is applied with
 * @param {string[]} options.ids the model and subagent model it sets
 * @param {number[]|null|Promise<number[]|null>} options.codexVersion the installed Codex's version
 * @param {typeof listedIds} [options.listIds] for tests
 * @param {() => boolean} [options.listBehind] for tests: does the list predate a write?
 * @returns {Promise<{ write: boolean, reason: "listed"|"codex-version"|"not-listed"|"lookup-failed" }>}
 */
export async function decideCatalogUrl({ apiKey, ids, codexVersion, listIds = listedIds, listBehind = routedModelsBehind }) {
  const wanted = ids.filter(Boolean);
  const key = apiKey || null;
  const lookup = (options) => listIds(key, options).then((set) => ({ set }), (error) => ({ error }));
  // The version check and the list lookup don't depend on each other: start
  // both, and don't wait for the list when the version already says no.
  const pending = lookup();
  if (!codexReadsCatalogUrl(await codexVersion)) return { write: false, reason: "codex-version" };
  let result = await pending;
  // Missing an id: look again, since a rebuild may have landed while the
  // version check ran. While the held list predates a write (a provider or
  // combo added just before Apply), wait for the build that includes it;
  // otherwise this returns the held list at once. A list that's merely old
  // isn't waited on; an alias or a bare name would still miss.
  if (!result.error && !wanted.every((id) => result.set.has(id))) result = await lookup({ fresh: listBehind() });
  if (result.error) return { write: false, reason: "lookup-failed" };
  if (wanted.length === 0 || !wanted.every((id) => result.set.has(id))) return { write: false, reason: "not-listed" };
  return { write: true, reason: "listed" };
}

/** Just the yes or no of decideCatalogUrl. */
export async function wantsCatalogUrl(options) {
  return (await decideCatalogUrl(options)).write;
}
