// The management key dialog's scope state: from a saved key, to the payload
// the dashboard sends. Pure functions, so the rules about which own-URL hosts
// are kept are unit-tested (tests/unit/management-keys.test.js).

export const blankScopes = () => ({
  clientKeys: { enabled: false, providers: [], models: [], maxBudgetUsd: "", manageExisting: false },
  providerKeys: { enabled: false, providers: [], manageExisting: false, baseUrlHosts: {} },
});

/** Dialog state from a saved key's scopes. */
export function fromSaved(scopes) {
  const s = blankScopes();
  if (!scopes) return s;
  const ck = scopes.clientKeys || {};
  const pk = scopes.providerKeys || {};
  return {
    clientKeys: {
      enabled: !!ck.enabled, providers: ck.providers || [], models: ck.models || [],
      maxBudgetUsd: ck.maxBudgetUsd === null || ck.maxBudgetUsd === undefined ? "" : String(ck.maxBudgetUsd),
      manageExisting: !!ck.manageExisting,
    },
    providerKeys: { enabled: !!pk.enabled, providers: pk.providers || [], manageExisting: !!pk.manageExisting, baseUrlHosts: pk.baseUrlHosts || {} },
  };
}

/**
 * Is this endpoint gone? `knownEndpoints` is the set of endpoint ids loaded
 * from the dashboard, or null while they haven't loaded (then nothing counts
 * as gone, so a slow load never drops hosts).
 */
export function isDeletedEndpoint(id, knownEndpoints) {
  return !!knownEndpoints && !knownEndpoints.has(id);
}

/** A new providers list; taking an endpoint out of the scope drops its hosts too. */
export function withProviders(pk, providers) {
  return {
    ...pk,
    providers,
    baseUrlHosts: providers.length
      ? Object.fromEntries(Object.entries(pk.baseUrlHosts).filter(([id]) => providers.includes(id)))
      : pk.baseUrlHosts,
  };
}

/**
 * The hosts to save: lists that have hosts, for endpoints still in the scope
 * and not deleted. A deleted endpoint's list is dropped, so saving the key
 * after the endpoint is gone works; the server still refuses an unknown one.
 */
export function ownUrlHostsPayload(pk, knownEndpoints = null) {
  const entries = Object.entries(pk.baseUrlHosts).filter(([id, hosts]) => hosts.length
    && (!pk.providers.length || pk.providers.includes(id))
    && !isDeletedEndpoint(id, knownEndpoints));
  return entries.length ? Object.fromEntries(entries) : null;
}

/** The scopes payload for /api/management-keys. */
export function toPayload(s, knownEndpoints = null) {
  const budget = s.clientKeys.maxBudgetUsd.trim();
  return {
    clientKeys: {
      enabled: s.clientKeys.enabled,
      providers: s.clientKeys.providers.length ? s.clientKeys.providers : null,
      models: s.clientKeys.models.length ? s.clientKeys.models : null,
      maxBudgetUsd: budget === "" ? null : Number(budget),
      manageExisting: s.clientKeys.manageExisting,
    },
    providerKeys: {
      enabled: s.providerKeys.enabled,
      providers: s.providerKeys.providers.length ? s.providerKeys.providers : null,
      manageExisting: s.providerKeys.manageExisting,
      baseUrlHosts: ownUrlHostsPayload(s.providerKeys, knownEndpoints),
    },
  };
}
