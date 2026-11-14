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
import { connectionsVersion, combosVersion } from "@/lib/db/index.js";

// Writes that change the routed list: connections, aliases, custom and
// disabled models, restores (connectionsVersion), and combos (combosVersion).
const writesVersion = () => `${connectionsVersion()}:${combosVersion()}`;

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
// `connections` is the writesVersion() the held list was built at.
// On globalThis: instrumentation (warmRoutedModels) and the route handlers
// are separate bundles and must share one list, as autoCombo's does.
const state = (globalThis._codexRoutedModels ??= {
  models: null, builtAt: 0, inflight: null, generation: 0, started: 0, written: 0, connections: -1,
});

function refresh() {
  if (state.inflight) return state.inflight;
  const generation = state.generation;
  const seq = ++state.started;
  // Read before the build, so a change made while it runs triggers another.
  const version = writesVersion();
  let deadline;
  const build = buildModelsList(["llm"]).then((models) => {
    if (generation !== state.generation || seq < state.written) return;
    state.models = models;
    state.builtAt = now();
    state.written = seq;
    state.connections = version;
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
  // A write since the list was built (writesVersion: a connection, combo,
  // alias, custom model, disabled model or restore)
  // makes it as old as a list past SERVE_STALE_MS: rebuilt, with the grace.
  const connectionsChanged = state.models && state.connections !== writesVersion();
  const age = !state.models ? Infinity : connectionsChanged ? ROUTED_MODELS_TIMING.SERVE_STALE_MS : now() - state.builtAt;
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

/**
 * The list once the build that reflects the latest writes is done: waits up
 * to `maxWaitMs` for a running build, or for one started now when the held
 * list predates a write (writesVersion). For the Codex settings route,
 * which may run right after a provider was added.
 * @param {number} maxWaitMs
 * @returns {Promise<object[]>}
 */
export async function getFreshRoutedModels(maxWaitMs) {
  const deadline = now() + maxWaitMs;
  // Twice at most: a build already running when the write landed is followed
  // by one that sees it.
  for (let pass = 0; pass < 2; pass++) {
    const behind = !state.models || state.connections !== writesVersion();
    if (!behind && !state.inflight) break;
    refresh();
    const left = deadline - now();
    if (left <= 0) break;
    await waitFor(state.inflight, left);
  }
  return state.models ?? getRoutedModels();
}

/** Does the held list predate a write (or is there none yet)? */
export function routedModelsBehind() {
  return !state.models || state.connections !== writesVersion();
}

/** Start building the list at server boot, so Codex's first request finds one. */
export function warmRoutedModels() {
  if (!state.models) refresh().catch(() => {});
}

export function resetRoutedModels() {
  state.generation += 1;
  state.models = null;
  state.builtAt = 0;
  state.inflight = null;
  state.written = 0;
}
