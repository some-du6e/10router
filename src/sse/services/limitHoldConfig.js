import { getSettings } from "@/lib/localDb";
import { getApiKeyLimitHold } from "@/lib/db/repos/apiKeysRepo.js";
import * as log from "../utils/logger.js";

/**
 * Resolve whether a request may hold its stream open through a provider rate limit.
 *
 * Per-key wins over global so one machine can run a patient CLI key and a
 * fail-fast CI key at the same time. A keyless request (local mode, or
 * requireApiKey off) has no override to read, so it takes the global.
 *
 * @param {string|null} apiKey - raw client API key, if any
 * @returns {Promise<{enabled: boolean, onPinned: boolean}>}
 */
export async function resolveLimitHold(apiKey) {
  const settings = await getSettings();
  const global = !!settings.limitHoldEnabled;
  const onPinned = !!settings.limitHoldOnPinned;

  let override = null;
  if (apiKey) {
    try {
      override = await getApiKeyLimitHold(apiKey);
    } catch (e) {
      // Fail-open to the global setting: a config read must never break routing.
      log.debug("LIMITHOLD", `key override lookup failed: ${e.message}`);
    }
  }

  return { enabled: override === null ? global : override, onPinned };
}
