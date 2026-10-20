import { getAdapter } from "../driver.js";

const DEFAULT_TTL_MS = 5000;

if (!global._dbReadCaches) global._dbReadCaches = {};

/**
 * Short-lived cache for a read-mostly table that is read on every request.
 * State lives on `global` so the Next.js middleware bundle (its own module
 * copy) shares it. Writers must call `invalidate()` after changing the table.
 * Returned values are shared; callers that hand them out must copy.
 */
export function makeReadCache(name, load, ttlMs = DEFAULT_TTL_MS) {
  if (!global._dbReadCaches[name]) {
    global._dbReadCaches[name] = { value: null, adapter: null, expiresAt: 0, generation: 0 };
  }
  const state = global._dbReadCaches[name];

  return {
    async get() {
      // A read that started before an invalidation must not publish stale rows.
      const startGeneration = state.generation;
      const db = await getAdapter();
      // Keyed on the adapter so a re-opened DB (tests, DATA_DIR change) never
      // serves rows from the previous file.
      if (state.adapter === db && state.expiresAt > Date.now()) return state.value;

      const value = await load(db);
      if (startGeneration === state.generation) {
        state.value = value;
        state.adapter = db;
        state.expiresAt = Date.now() + ttlMs;
      }
      return value;
    },
    invalidate() {
      state.generation += 1;
      state.value = null;
      state.adapter = null;
      state.expiresAt = 0;
    },
  };
}
