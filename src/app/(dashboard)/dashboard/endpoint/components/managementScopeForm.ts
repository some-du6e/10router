// The management key dialog's scope state: from a saved key, to the payload
// the dashboard sends. Pure functions, so the rules about which own-URL hosts
// are kept are unit-tested (tests/unit/management-keys.test.js).

/** Endpoint id to its allowed host patterns. */
export type HostMap = Record<string, string[]>;

export interface ClientKeysForm {
  enabled: boolean;
  providers: string[];
  models: string[];
  maxBudgetUsd: string;
  manageExisting: boolean;
}

export interface ProviderKeysForm {
  enabled: boolean;
  providers: string[];
  manageExisting: boolean;
  baseUrlHosts: HostMap;
}

export interface ScopesForm {
  clientKeys: ClientKeysForm;
  providerKeys: ProviderKeysForm;
}

/** A saved key's scopes, as the dashboard list returns them. */
interface SavedScopes {
  clientKeys?: {
    enabled?: boolean;
    providers?: string[] | null;
    models?: string[] | null;
    maxBudgetUsd?: number | null;
    manageExisting?: boolean;
  } | null;
  providerKeys?: {
    enabled?: boolean;
    providers?: string[] | null;
    manageExisting?: boolean;
    baseUrlHosts?: HostMap | null;
  } | null;
}

export const blankScopes = (): ScopesForm => ({
  clientKeys: { enabled: false, providers: [], models: [], maxBudgetUsd: "", manageExisting: false },
  providerKeys: { enabled: false, providers: [], manageExisting: false, baseUrlHosts: {} },
});

/** Dialog state from a saved key's scopes. */
export function fromSaved(scopes: SavedScopes | null | undefined): ScopesForm {
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

// Endpoint ids compare without case, as the server's checks do.
const sameId = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const listed = (ids: Iterable<string>, id: string): boolean => [...ids].some((x) => sameId(x, id));

/**
 * Is this endpoint gone? `knownEndpoints` is the set of endpoint ids loaded
 * from the dashboard, or null while they haven't loaded (then nothing counts
 * as gone, so a slow load never drops hosts).
 */
export function isDeletedEndpoint(id: string, knownEndpoints: Set<string> | null): boolean {
  return !!knownEndpoints && !listed(knownEndpoints, id);
}

/** A new providers list; taking an endpoint out of the scope drops its hosts too. */
export function withProviders(pk: ProviderKeysForm, providers: string[]): ProviderKeysForm {
  return {
    ...pk,
    providers,
    baseUrlHosts: providers.length
      ? Object.fromEntries(Object.entries(pk.baseUrlHosts).filter(([id]) => listed(providers, id)))
      : pk.baseUrlHosts,
  };
}

/**
 * The hosts to save: lists that have hosts, for endpoints still in the scope
 * and not deleted. A deleted endpoint's list is dropped, so saving the key
 * after the endpoint is gone works; the server still refuses an unknown one.
 */
export function ownUrlHostsPayload(pk: ProviderKeysForm, knownEndpoints: Set<string> | null = null): HostMap | null {
  const entries = Object.entries(pk.baseUrlHosts).filter(([id, hosts]) => hosts.length
    && (!pk.providers.length || listed(pk.providers, id))
    && !isDeletedEndpoint(id, knownEndpoints));
  return entries.length ? Object.fromEntries(entries) : null;
}

/** The scopes payload for /api/management-keys. */
export function toPayload(s: ScopesForm, knownEndpoints: Set<string> | null = null) {
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
