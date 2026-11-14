import { DEMOTE_PREFIX, SOFT_DEMOTE_PREFIX } from "@/shared/utils/connectionStatus.js";

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
// Demotions (authDemote_<model>) follow the server too: turning a key on drops them.
export function withToggledActive(connection, isActive, saved) {
  const demotions = saved ? Object.fromEntries(Object.keys({ ...connection, ...saved })
    .filter((key) => key.startsWith(DEMOTE_PREFIX) || key.startsWith(SOFT_DEMOTE_PREFIX)).map((key) => [key, saved[key] ?? null])) : {};
  return { ...connection, ...demotions, isActive, autoDisabledAt: saved?.autoDisabledAt ?? null, autoDisabledReason: saved?.autoDisabledReason ?? null };
}

// What "Test all" tests: like /api/providers/test-batch, connections that are off
// (by hand or automatically) are skipped.
export function connectionsToTest(connections) {
  return connections.filter((c) => c.isActive !== false);
}

// Per-key lifespan estimates for a provider ({} when there are none or the
// request fails: the rows then show no estimate).
export async function fetchKeyLifespans(providerId) {
  try {
    const res = await fetch(`/api/providers/lifespan?provider=${encodeURIComponent(providerId)}`, { cache: "no-store" });
    return res.ok ? (await res.json()).keys || {} : {};
  } catch {
    return {};
  }
}

export function withLifespans(connections, keys) {
  return connections.map((c) => ({ ...c, lifespan: keys?.[c.id] || null }));
}
