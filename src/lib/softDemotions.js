// Soft demotions (AUTH_SOFT_DEMOTE in open-sse/config/runtimeConfig.js) are
// stored on the connection as authSoft_<model>. sse/services/auth.js caches
// them here, `${connectionId}|${model}` → the record plus the lease of a try
// that is out. On global so duplicated Next.js module instances share it.
export const softDemotions = (global._softDemotions ??= new Map());

// Drops the connection's cached soft demotions: on `model`, or on every model.
export function clearSoftDemotions(connectionId, model = null) {
  if (model) {
    softDemotions.delete(`${connectionId}|${model}`);
    return;
  }
  for (const key of softDemotions.keys()) if (key.startsWith(`${connectionId}|`)) softDemotions.delete(key);
}
