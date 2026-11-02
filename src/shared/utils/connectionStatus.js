export function getStatusVariant(isActive, effectiveStatus) {
  if (isActive === false) return "default";
  if (effectiveStatus === "active" || effectiveStatus === "success") return "success";
  if (effectiveStatus === "error" || effectiveStatus === "expired" || effectiveStatus === "unavailable") return "error";
  return "default";
}

// Must match AUTH_DEMOTE_PREFIX in src/lib/db/repos/connectionsRepo.js
// (server-only, so not imported here).
export const DEMOTE_PREFIX = "authDemote_";

// Models an active key is demoted on after repeated 403s there: records with
// demotedAt (a success on the model deletes its record; turning the key back
// on deletes them all). The next test waits for both nextProbeAt and the
// last probe's lease, like the router and /api/models/availability.
export function demotedModels(connection) {
  if (!connection || connection.isActive === false) return [];
  return Object.entries(connection)
    .filter(([key, record]) => key.startsWith(DEMOTE_PREFIX) && record?.demotedAt)
    .map(([key, record]) => {
      const times = [record.nextProbeAt, record.leaseUntil].filter(Boolean).map(t => new Date(t).getTime()).filter(Number.isFinite);
      return { model: key.slice(DEMOTE_PREFIX.length), reason: record.reason || null, nextTestAt: times.length ? Math.max(...times) : null };
    });
}

// The dashboard's label for demotedModels, with one hover line per model. The
// router still uses a demoted key when no other key can serve the model, and
// tests it at most once per probe interval; when, depends on the strategy.
export function demotedLabel(connection, now = Date.now()) {
  const demoted = demotedModels(connection);
  if (!demoted.length) return null;
  const line = ({ model, reason, nextTestAt }) => `Other keys go first on ${model} after repeated ${reason || "refusals"}; `
    + (nextTestAt > now ? `not tested on ${model} again before ${new Date(nextTestAt).toLocaleString()}` : `due for a test on ${model}`);
  return { text: `Demoted on ${demoted.map(d => d.model).join(", ")}`, title: demoted.map(line).join("\n") };
}

// lastError as auth.js writes it on demotion ("<model> demoted after repeated
// <status> …"). The label says it while the key is demoted; once the record is
// gone (a success, or the key turned back on) the message is stale.
const DEMOTION_ERROR = /^\S+ demoted after repeated \d{3}\b/;
export function isDemotionError(connection) {
  return DEMOTION_ERROR.test(String(connection?.lastError || ""));
}
