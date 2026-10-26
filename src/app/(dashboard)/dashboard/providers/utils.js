export const STATUS_FILTER_OPTIONS = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
  { value: "none", label: "No connection" },
];

// noAuth providers (e.g. free proxies) are always usable even though they
// never have a stored connection record, so they never fall into "none".
export function getConnectionStatus(stats, isNoAuth = false) {
  if (isNoAuth) return "active";
  if (!stats || stats.total === 0) return "none";
  return stats.allDisabled ? "inactive" : "active";
}

export function matchesStatusFilter(statusFilter, stats, isNoAuth = false) {
  if (statusFilter === "all") return true;
  return getConnectionStatus(stats, isNoAuth) === statusFilter;
}

// The automatic turn-off label after a toggle is whatever the server kept:
// turning a key on clears it, turning an already auto-disabled key off keeps it.
export function withToggledActive(connection, isActive, saved) {
  return { ...connection, isActive, autoDisabledAt: saved?.autoDisabledAt ?? null, autoDisabledReason: saved?.autoDisabledReason ?? null };
}

// What "Test all" tests: like /api/providers/test-batch, connections that are off
// (by hand or automatically) are skipped.
export function connectionsToTest(connections) {
  return connections.filter((c) => c.isActive !== false);
}
