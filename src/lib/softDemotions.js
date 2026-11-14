// Soft demotions (AUTH_SOFT_DEMOTE in open-sse/config/runtimeConfig.js), kept
// by sse/services/auth.js in memory: `${connectionId}|${model}` →
// { apiKey, level, tryAt, leaseUntil }. On global so duplicated Next.js module
// instances share them.
export const softDemotions = (global._softDemotions ??= new Map());

// Ends the connection's soft demotions: on `model`, or on every model.
export function clearSoftDemotions(connectionId, model = null) {
  if (model) {
    softDemotions.delete(`${connectionId}|${model}`);
    return;
  }
  for (const key of softDemotions.keys()) if (key.startsWith(`${connectionId}|`)) softDemotions.delete(key);
}
