// The routed model list behind /backend-api/codex/models, cached for that route.
//
// Codex gives the whole catalog request 5 seconds, body included, and with
// `model_catalog_url` set it has no list of its own to fall back on. Building
// the list can call live provider catalogs (Copilot, Kiro, Cursor, compatible
// /models), each allowed several seconds, so the route can't always build it
// within the request.
//
// - Younger than FRESH_MS: served as is.
// - Up to SERVE_STALE_MS: served at once, rebuilt in the background.
// - Older, or none yet: rebuilt, and the request waits up to WAIT_MS for it.
//   If it isn't done by then, the old list is served, or with none the static
//   lists (no live catalogs).
// Codex refetches about every 5 minutes, so SERVE_STALE_MS keeps what it gets
// no older than that. A rebuild that hangs is abandoned after BUILD_DEADLINE_MS.
import { buildModelsList } from "@/app/api/v1/models/route.js";

export const ROUTED_MODELS_TIMING = {
  FRESH_MS: 60_000,
  SERVE_STALE_MS: 300_000,
  WAIT_MS: 3_500,
  BUILD_DEADLINE_MS: 30_000,
};

const state = { models: null, builtAt: 0, inflight: null, generation: 0 };

function refresh() {
  if (state.inflight) return state.inflight;
  const generation = state.generation;
  let deadline;
  const build = buildModelsList(["llm"]).then((models) => {
    if (generation !== state.generation) return;
    state.models = models;
    state.builtAt = Date.now();
  });
  const timedOut = new Promise((_, reject) => {
    deadline = setTimeout(
      () => reject(new Error(`no list after ${ROUTED_MODELS_TIMING.BUILD_DEADLINE_MS}ms`)),
      ROUTED_MODELS_TIMING.BUILD_DEADLINE_MS,
    );
    deadline.unref?.();
  });
  state.inflight = Promise.race([build, timedOut])
    .catch((error) => {
      console.log(`[codex catalog] model list refresh failed: ${error?.message || error}`);
    })
    .finally(() => {
      clearTimeout(deadline);
      if (generation === state.generation) state.inflight = null;
    });
  return state.inflight;
}

/**
 * The routed LLM models (unfiltered; apply the key's allowlist after).
 * @returns {Promise<object[]>}
 */
export async function getRoutedModels() {
  const age = state.models ? Date.now() - state.builtAt : Infinity;
  if (age < ROUTED_MODELS_TIMING.FRESH_MS) return state.models;
  refresh();
  if (age < ROUTED_MODELS_TIMING.SERVE_STALE_MS) return state.models;

  let timer;
  await Promise.race([
    state.inflight,
    new Promise((resolve) => { timer = setTimeout(resolve, ROUTED_MODELS_TIMING.WAIT_MS); timer.unref?.(); }),
  ]);
  clearTimeout(timer);
  if (state.models) return state.models;
  return buildModelsList(["llm"], { skipDynamicFetch: true, skipLiveCatalogs: true });
}

export function resetRoutedModels() {
  state.generation += 1;
  state.models = null;
  state.builtAt = 0;
  state.inflight = null;
}
