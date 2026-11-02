export function getStatusVariant(isActive, effectiveStatus) {
  if (isActive === false) return "default";
  if (effectiveStatus === "active" || effectiveStatus === "success") return "success";
  if (effectiveStatus === "error" || effectiveStatus === "expired" || effectiveStatus === "unavailable") return "error";
  return "default";
}

// authDemote_<model>: a key's demotion record on that model (see connectionsRepo.js).
export const DEMOTE_PREFIX = "authDemote_";

// Models an active key is demoted on: records with demotedAt.
export function demotedModels(connection) {
  if (!connection || connection.isActive === false) return [];
  return Object.entries(connection)
    .filter(([key, record]) => key.startsWith(DEMOTE_PREFIX) && record?.demotedAt)
    .map(([key, record]) => ({ model: key.slice(DEMOTE_PREFIX.length), reason: record.reason || null }));
}

export function demotedLabel(connection) {
  const demoted = demotedModels(connection);
  if (!demoted.length) return null;
  const line = ({ model, reason }) => `Demoted on ${model} after repeated ${reason || "refusals"}. Switching the key off and on clears it.`;
  return { text: `Demoted on ${demoted.map(d => d.model).join(", ")}`, title: demoted.map(line).join("\n") };
}

// The lastError auth.js writes on demotion: the label shows it while the key
// is demoted, and it is stale once the record is gone.
const DEMOTION_ERROR = /^\S+ demoted after repeated \d{3}\b/;
export function isDemotionError(connection) {
  return DEMOTION_ERROR.test(String(connection?.lastError || ""));
}
