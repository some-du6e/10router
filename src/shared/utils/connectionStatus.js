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

// The dashboard's label for demotedModels, with one hover line per model.
export function demotedLabel(connection, now = Date.now()) {
  const demoted = demotedModels(connection);
  if (!demoted.length) return null;
  const line = ({ model, reason, nextTestAt }) => `Other keys go first on ${model} after repeated ${reason || "refusals"}; `
    + (nextTestAt > now ? `not tested there again before ${new Date(nextTestAt).toLocaleString()}` : "tested on its next request for this model");
  return { text: `Demoted on ${demoted.map(d => d.model).join(", ")}`, title: demoted.map(line).join("\n") };
}

// lastError as written when the key was demoted on one of these models: the
// label already says it.
export function isDemotionError(connection, lastError = connection?.lastError) {
  return !!lastError && demotedModels(connection).some(({ model }) => String(lastError).startsWith(`${model} demoted after repeated `));
}
