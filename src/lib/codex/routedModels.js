// The routed model list behind /backend-api/codex/models, cached for that route.
//
// Codex gives the whole catalog request 5 seconds, body included, and with
// `model_catalog_url` set it has no list of its own to fall back on. Building
// the list can call live provider catalogs (Copilot, Kiro, Cursor, compatible
// /models), each allowed several seconds, so the route can't build it per
// request. It serves the last good list, refreshes it in the background once
// it is a minute old, and on a cold start waits at most COLD_WAIT_MS before
// answering with the static list (no live catalogs) instead.
import { buildModelsList } from "@/app/api/v1/models/route.js";

const FRESH_MS = 60_000;
const COLD_WAIT_MS = 2_000;

const state = { models: null, builtAt: 0, inflight: null, generation: 0 };

function refresh() {
  if (state.inflight) return state.inflight;
  const generation = state.generation;
  state.inflight = buildModelsList(["llm"])
    .then((models) => {
      if (generation !== state.generation) return;
      state.models = models;
      state.builtAt = Date.now();
    })
    .catch((error) => {
      console.log(`[codex catalog] model list refresh failed: ${error?.message || error}`);
    })
    .finally(() => {
      if (generation === state.generation) state.inflight = null;
    });
  return state.inflight;
}

/**
 * The routed LLM models (unfiltered; apply the key's allowlist after).
 * @returns {Promise<object[]>}
 */
export async function getRoutedModels() {
  if (!state.models || Date.now() - state.builtAt >= FRESH_MS) refresh();
  if (state.models) return state.models;

  let timer;
  await Promise.race([
    state.inflight,
    new Promise((resolve) => { timer = setTimeout(resolve, COLD_WAIT_MS); timer.unref?.(); }),
  ]);
  clearTimeout(timer);
  if (state.models) return state.models;
  // Still building: answer from the static lists now; the full list is
  // served once it lands.
  return buildModelsList(["llm"], { skipDynamicFetch: true, skipLiveCatalogs: true });
}

export function resetRoutedModels() {
  state.generation += 1;
  state.models = null;
  state.builtAt = 0;
  state.inflight = null;
}
