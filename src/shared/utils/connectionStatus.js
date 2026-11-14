import { AUTH_DEAD_CONFIG } from "../../../open-sse/config/errorConfig.js";

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

// When a soft demotion was last refused for the key itself: keyRefusedAt; on
// a record from before it was kept, its last refusal if it had refused tries
// (`tries`), else when it began.
export const keyRefusedAtOf = (r) => r.keyRefusedAt ?? (r.tries > 0 ? r.lastRefusedAt : r.since);

// The models a key was refused for itself on at or after fromMs: its soft
// demotions for refusals of the key itself, and its demotion counts that
// aren't of one model (authDemote_<model>, by lastCountedAt).
export function modelsRefusedForItself(connection, fromMs) {
  const at = (iso) => Date.parse(iso) >= fromMs;
  const entries = Object.entries(connection);
  return [...new Set([
    ...entries.filter(([key, r]) => key.startsWith(SOFT_DEMOTE_PREFIX) && r?.since && r.keyRefused === true && at(keyRefusedAtOf(r)))
      .map(([key]) => key.slice(SOFT_DEMOTE_PREFIX.length)),
    ...entries.filter(([key, r]) => key.startsWith(DEMOTE_PREFIX) && r && !r.modelScoped && at(r.lastCountedAt))
      .map(([key]) => key.slice(DEMOTE_PREFIX.length)),
  ])];
}

// Refused the way the turn-off rule (isAuthDead) needs: for itself on
// minModels models, or minFailures 401s in a row while soft-demoted for itself
// (authHeld401s, counted since its last success and its last other refusal).
export const refusedLikeDead = (connection, models) => new Set(models).size >= AUTH_DEAD_CONFIG.minModels
  || connection.authHeld401s >= AUTH_DEAD_CONFIG.minFailures;

// Soft-demoted for refusals of the key itself and, since its last success
// (authServedAt), refused like a dead key.
export const softLooksDead = (connection) => refusedLikeDead(connection,
  modelsRefusedForItself(connection, Date.parse(connection.authServedAt) || -Infinity));

// Models an active key is demoted on: records with demotedAt, and soft demotions.
export function demotedModels(connection) {
  if (!connection || connection.isActive === false) return [];
  return Object.entries(connection).flatMap(([key, record]) => {
    if (key.startsWith(DEMOTE_PREFIX) && record?.demotedAt) {
      return [{ model: key.slice(DEMOTE_PREFIX.length), reason: record.reason || null }];
    }
    if (key.startsWith(SOFT_DEMOTE_PREFIX) && record?.since) {
      // Refused for itself, and like a dead key since its last success: likely dead.
      const keyRefused = record.keyRefused === true && softLooksDead(connection);
      return [{ model: key.slice(SOFT_DEMOTE_PREFIX.length), soft: true, lastRefusedAt: record.lastRefusedAt || record.since, keyRefused }];
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
