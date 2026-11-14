// Soft demotions (AUTH_SOFT_DEMOTE in open-sse/config/runtimeConfig.js) are
// stored on the connection as authSoft_<model>. sse/services/auth.js caches
// them here, `${connectionId}|${model}` → the record plus the lease of a try
// that is out. On global so duplicated Next.js module instances share it.
import { AUTH_SOFT_DEMOTE } from "../../open-sse/config/runtimeConfig.js";
import { DEMOTE_PREFIX, SOFT_DEMOTE_PREFIX } from "../shared/utils/connectionStatus.js";

export const softDemotions = (global._softDemotions ??= new Map());

// The connection as the dashboard gets it: without soft demotions, or
// demotions a 401 of a soft-demoted key counted toward (held401), while
// AUTH_SOFT_DEMOTE is off, since the router then ignores them.
export function withSoftDemotionsShown(connection) {
  if (AUTH_SOFT_DEMOTE.enabled || !connection) return connection;
  return Object.fromEntries(Object.entries(connection)
    .filter(([k, r]) => !k.startsWith(SOFT_DEMOTE_PREFIX) && !(k.startsWith(DEMOTE_PREFIX) && r?.held401)));
}

// Drops the connection's cached soft demotions: on `model`, or on every model.
export function clearSoftDemotions(connectionId, model = null) {
  if (model) {
    softDemotions.delete(`${connectionId}|${model}`);
    return;
  }
  for (const key of softDemotions.keys()) if (key.startsWith(`${connectionId}|`)) softDemotions.delete(key);
}
