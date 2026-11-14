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
// - Older: rebuilt, and the request waits up to STALE_GRACE_MS for it before
//   serving the old list. Codex asks about every 5 minutes, so this is the
//   usual case, and the wait is kept short to leave Codex time for the body.
// - None yet (cold start): the request waits up to WAIT_MS, then gets the
//   static lists (no live catalogs), which are then held as a stale list.
// A rebuild that hangs is abandoned after BUILD_DEADLINE_MS. Ages use a
// monotonic clock, so a wall-clock step can't freeze or expire the list; it
// doesn't advance while the machine sleeps, which only makes a list look
// younger by the time asleep, when little can have changed.
import { buildModelsList } from "@/app/api/v1/models/route.js";

export const ROUTED_MODELS_TIMING = {
  FRESH_MS: 60_000,
  SERVE_STALE_MS: 300_000,
  STALE_GRACE_MS: 1_000,
  WAIT_MS: 3_500,
  BUILD_DEADLINE_MS: 30_000,
};

const now = () => performance.now();

// `written` is the sequence number of the build the held list came from, so a
// slow build that was abandoned can't replace a newer one when it lands late.
const state = { models: null, builtAt: 0, inflight: null, generation: 0, started: 0, written: 0 };

function refresh() {
  if (state.inflight) return state.inflight;
  const generation = state.generation;
  const seq = ++state.started;
  let deadline;
  const build = buildModelsList(["llm"]).then((models) => {
    if (generation !== state.generation || seq < state.written) return;
    state.models = models;
    state.builtAt = now();
    state.written = seq;
  });
  const timedOut = new Promise((_, reject) => {
    deadline = setTimeout(
      () => reject(new Error(`no list after ${ROUTED_MODELS_TIMING.BUILD_DEADLINE_MS}ms`)),
      ROUTED_MODELS_TIMING.BUILD_DEADLINE_MS,
    );
    deadline.unref?.();
  });
  // After the deadline the build is no longer waited on, but a late result
  // still lands through its `.then` above.
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

async function waitFor(promise, ms) {
  let timer;
  await Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(resolve, ms); timer.unref?.(); }),
  ]);
  clearTimeout(timer);
}

/**
 * The routed LLM models (unfiltered; apply the key's allowlist after).
 * @returns {Promise<object[]>}
 */
export async function getRoutedModels() {
  const age = state.models ? now() - state.builtAt : Infinity;
  if (age < ROUTED_MODELS_TIMING.FRESH_MS) return state.models;
  refresh();
  if (age < ROUTED_MODELS_TIMING.SERVE_STALE_MS) return state.models;

  if (state.models) {
    await waitFor(state.inflight, ROUTED_MODELS_TIMING.STALE_GRACE_MS);
    return state.models;
  }
  await waitFor(state.inflight, ROUTED_MODELS_TIMING.WAIT_MS);
  if (state.models) return state.models;
  const generation = state.generation;
  const fallback = await buildModelsList(["llm"], { skipDynamicFetch: true, skipLiveCatalogs: true });
  // Held as an already-stale list, so the next request gets it after the
  // short grace (not the full wait again) while the real build runs, and any
  // real build replaces it.
  if (!state.models && generation === state.generation) {
    state.models = fallback;
    state.builtAt = now() - ROUTED_MODELS_TIMING.SERVE_STALE_MS;
  }
  return fallback;
}

export function resetRoutedModels() {
  state.generation += 1;
  state.models = null;
  state.builtAt = 0;
  state.inflight = null;
  state.written = 0;
}
