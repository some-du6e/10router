export function getStatusVariant(isActive, effectiveStatus) {
  if (isActive === false) return "default";
  if (effectiveStatus === "active" || effectiveStatus === "success") return "success";
  if (effectiveStatus === "error" || effectiveStatus === "expired" || effectiveStatus === "unavailable") return "error";
  return "default";
}

// authDemote_<model>: a key's demotion record on that model; authSoft_<model>:
// its soft demotion there (see connectionsRepo.js).
export const DEMOTE_PREFIX = "authDemote_";
export const SOFT_DEMOTE_PREFIX = "authSoft_";

// Models an active key is demoted on: records with demotedAt, and soft demotions.
export function demotedModels(connection) {
  if (!connection || connection.isActive === false) return [];
  return Object.entries(connection).flatMap(([key, record]) => {
    if (key.startsWith(DEMOTE_PREFIX) && record?.demotedAt) {
      return [{ model: key.slice(DEMOTE_PREFIX.length), reason: record.reason || null }];
    }
    if (key.startsWith(SOFT_DEMOTE_PREFIX) && record?.since) {
      return [{ model: key.slice(SOFT_DEMOTE_PREFIX.length), soft: true, lastRefusedAt: record.lastRefusedAt || record.since, keyRefused: record.keyRefused === true }];
    }
    return [];
  });
}

export function demotedLabel(connection) {
  const demoted = demotedModels(connection);
  if (!demoted.length) return null;
  const line = ({ model, reason, soft, lastRefusedAt, keyRefused }) => (soft
    ? `Soft-demoted on ${model}: last refused ${new Date(lastRefusedAt).toLocaleString()}. Other keys go first there until it serves ${model} again. `
      + (keyRefused ? "The upstream keeps refusing the key itself: if that goes on, replace the key. " : "")
      + "Switching the key off and on clears it."
    : `Demoted on ${model} after repeated ${reason || "refusals"}. Switching the key off and on clears it.`);
  const hard = demoted.filter(d => !d.soft).map(d => d.model);
  const soft = demoted.filter(d => d.soft).map(d => d.model);
  const text = [hard.length && `Demoted on ${hard.join(", ")}`, soft.length && `${hard.length ? "soft-demoted" : "Soft-demoted"} on ${soft.join(", ")}`]
    .filter(Boolean).join(", ");
  return { text, title: demoted.map(line).join("\n") };
}

// The lastError auth.js writes on demotion: the label shows it while the key
// is demoted, and it is stale once the record is gone.
const DEMOTION_ERROR = /^\S+ demoted after repeated \d{3}\b/;
export function isDemotionError(connection) {
  return DEMOTION_ERROR.test(String(connection?.lastError || ""));
}
