export function getStatusVariant(isActive, effectiveStatus) {
  if (isActive === false) return "default";
  if (effectiveStatus === "active" || effectiveStatus === "success") return "success";
  if (effectiveStatus === "error" || effectiveStatus === "expired" || effectiveStatus === "unavailable") return "error";
  return "default";
}

// Models a key is demoted on after repeated 403s there (authDemote_<model>
// records with demotedAt; a success on the model clears its record).
export function demotedModels(connection) {
  return Object.entries(connection || {})
    .filter(([key, record]) => key.startsWith("authDemote_") && record?.demotedAt)
    .map(([key, record]) => ({ model: key.slice("authDemote_".length), nextProbeAt: record.nextProbeAt || null, reason: record.reason || null }));
}

export function demotedLabel(connection) {
  const demoted = demotedModels(connection);
  if (!demoted.length) return null;
  const next = demoted.map(d => new Date(d.nextProbeAt).getTime()).filter(Number.isFinite).sort((a, b) => a - b)[0];
  return {
    text: `Demoted on ${demoted.map(d => d.model).join(", ")}`,
    title: `Tried last on ${demoted.map(d => d.model).join(", ")} after repeated ${demoted[0].reason || "refusals"}${next ? `; next test ${new Date(next).toLocaleString()}` : ""}`,
  };
}
