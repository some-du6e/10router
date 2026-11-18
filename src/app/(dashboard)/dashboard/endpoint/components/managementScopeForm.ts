// The management key dialog's scope state: from a saved key, to the payload
// the dashboard sends. Pure functions, so the rules about which own-URL hosts
// are kept are unit-tested (tests/unit/management-keys.test.js).
import { OPENAI_COMPATIBLE_PREFIX, ANTHROPIC_COMPATIBLE_PREFIX, CUSTOM_EMBEDDING_PREFIX } from "@/shared/constants/providers.js";

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

/** Is this a custom endpoint's id (a provider node), rather than a built-in provider? */
export function isCustomEndpointId(id: string): boolean {
  return [OPENAI_COMPATIBLE_PREFIX, ANTHROPIC_COMPATIBLE_PREFIX, CUSTOM_EMBEDDING_PREFIX].some((p) => id.startsWith(p));
}

/**
 * Is this custom endpoint gone? `knownEndpoints` is the set of endpoint ids
 * loaded from the dashboard, or null while they haven't loaded (then nothing
 * counts as gone, so a slow or failed load never drops anything). Built-in
 * providers are never gone.
 */
export function isDeletedEndpoint(id: string, knownEndpoints: Set<string> | null): boolean {
  return !!knownEndpoints && isCustomEndpointId(id) && !listed(knownEndpoints, id);
}

/**
 * The provider-keys providers to save: deleted endpoints are left out, so a
 * key that named one can still be saved. If that would empty a list that
 * wasn't empty, it is kept as it is: an empty list means "any provider", so
 * dropping the last one would widen the scope. With provider keys on,
 * scopeProblem stops the save and tells the admin. With them off the save
 * goes through: the server doesn't check an off scope's providers, and the
 * kept list is checked again (and stops the save) when it's turned back on.
 */
export function providersPayload(pk: ProviderKeysForm, knownEndpoints: Set<string> | null = null): string[] | null {
  if (!pk.providers.length) return null;
  const kept = pk.providers.filter((id) => !isDeletedEndpoint(id, knownEndpoints));
  return kept.length ? kept : pk.providers;
}

/** Why the dialog can't save these scopes as they are, or null. */
export function scopeProblem(s: ScopesForm, knownEndpoints: Set<string> | null = null): string | null {
  const pk = s.providerKeys;
  if (pk.enabled && pk.providers.length && pk.providers.every((id) => isDeletedEndpoint(id, knownEndpoints))) {
    return "Every provider this key's provider keys were limited to has been deleted. Pick a provider, or turn provider keys off.";
  }
  return null;
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
      providers: providersPayload(s.providerKeys, knownEndpoints),
      manageExisting: s.providerKeys.manageExisting,
      baseUrlHosts: ownUrlHostsPayload(s.providerKeys, knownEndpoints),
    },
  };
}
