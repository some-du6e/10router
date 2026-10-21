import REGISTRY from "open-sse/providers/registry/index.js";
import { stripContextWindowSuffix } from "open-sse/services/model.js";
import { getProviderConnections, getSettings, getModelAliases, getComboByName } from "@/lib/localDb";

// How a provider is paid for. Auto combos skip the sets the user blocks, so a
// request for a free model never quietly falls back to a metered key.
//   payg         pay per token with an API key (OpenAI, Anthropic, Groq, ...)
//   freeTier     free up to a limit, then paid (OpenRouter, Gemini API, ...)
//   subscription flat-rate plan you log in to (Claude Code, Codex, Copilot, ...)
//   free         no billing at all (Kiro, Gemini CLI, ...)
//   custom       an endpoint you added yourself
export const AUTO_COMBO_BILLING_SETS = ["payg", "freeTier", "subscription", "free", "custom"] as const;
export type BillingSet = (typeof AUTO_COMBO_BILLING_SETS)[number];
// Custom endpoints are usually metered keys, so they start blocked too.
export const DEFAULT_AUTO_COMBO_BLOCKED_BILLING: BillingSet[] = ["payg", "freeTier", "custom"];

const BILLING_BY_CATEGORY: Record<string, BillingSet> = {
  apikey: "payg",
  freeTier: "freeTier",
  oauth: "subscription",
  webCookie: "subscription",
  free: "free",
};

interface RegistryEntry {
  id: string;
  alias?: string;
  uiAlias?: string;
  aliases?: string[];
  category?: string;
  noAuth?: boolean;
}

const REGISTRY_BY_ID = new Map<string, RegistryEntry>();
const PROVIDER_ID_BY_KEY = new Map<string, string>();
for (const entry of REGISTRY as RegistryEntry[]) {
  REGISTRY_BY_ID.set(entry.id, entry);
  // /v1/models prefixes ids with uiAlias when a provider has one, so every
  // name a provider can appear under has to map back to it.
  for (const key of [entry.id, entry.alias, entry.uiAlias, ...(entry.aliases || [])]) {
    if (key && !PROVIDER_ID_BY_KEY.has(key)) PROVIDER_ID_BY_KEY.set(key, entry.id);
  }
}

interface Connection {
  provider: string;
  authType?: string;
  isActive?: boolean;
  providerSpecificData?: { prefix?: string };
}

/**
 * Billing set for one connection. An OAuth provider reached with an API key
 * (xAI, Kimi, ...) bills per token, so the connection's auth decides, not
 * only the provider's category.
 */
export function connectionBilling(conn: Connection): BillingSet {
  const entry = REGISTRY_BY_ID.get(conn.provider);
  if (!entry) return "custom";
  if (entry.noAuth) return "free";
  const byCategory = BILLING_BY_CATEGORY[entry.category || ""] || "payg";
  if (byCategory === "subscription" && conn.authType === "apikey") return "payg";
  return byCategory;
}

interface CatalogEntry {
  id: string;
  prefix: string;
  provider: string;
  billing: BillingSet;
}

const CATALOG_TTL_MS = 60_000;
const CATALOG_RETRY_MS = 5_000;
// One slow upstream /models must not stall the refresh forever.
const CATALOG_BUILD_TIMEOUT_MS = 30_000;
const COLD_START_WAIT_MS = 3_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());

interface CatalogState {
  entries: CatalogEntry[] | null;
  expiresAt: number;
  refreshing: Promise<void> | null;
  connectionsVersion: number;
}

// Bumped by the connections repo on every write; a change makes the catalog stale.
declare global {
  var _connectionsVersion: number | undefined;
}
const connectionsVersion = () => globalThis._connectionsVersion || 0;

const catalog: CatalogState = { entries: null, expiresAt: 0, refreshing: null, connectionsVersion: -1 };

async function buildCatalog(): Promise<CatalogEntry[]> {
  const conns = ((await getProviderConnections()) as Connection[]).filter((c) => c.isActive !== false);
  // With nothing connected, buildModelsList returns the whole static catalog,
  // which would build combos out of providers that have no credentials.
  if (conns.length === 0) return [];

  // buildModelsList lists the first active connection of each provider.
  const connByProvider = new Map<string, Connection>();
  const providerByPrefix = new Map<string, string>();
  for (const c of conns) {
    if (!connByProvider.has(c.provider)) connByProvider.set(c.provider, c);
    const prefix = c.providerSpecificData?.prefix?.trim();
    if (prefix) providerByPrefix.set(prefix, c.provider);
  }

  const { buildModelsList } = await import("@/app/api/v1/models/route.js");
  const list = (await buildModelsList(["llm"])) as { id?: string; owned_by?: string }[];
  const entries: CatalogEntry[] = [];
  for (const m of list) {
    if (m.owned_by === "combo" || typeof m.id !== "string" || !m.id.includes("/")) continue;
    const prefix = m.id.slice(0, m.id.indexOf("/"));
    const provider = providerByPrefix.get(prefix) || PROVIDER_ID_BY_KEY.get(prefix) || prefix;
    const conn = connByProvider.get(provider);
    entries.push({ id: m.id, prefix, provider, billing: conn ? connectionBilling(conn) : "custom" });
  }
  return entries;
}

function refreshCatalog(): Promise<void> {
  if (catalog.refreshing) return catalog.refreshing;
  const version = connectionsVersion();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("catalog build timed out")), CATALOG_BUILD_TIMEOUT_MS);
  });
  catalog.refreshing = Promise.race([buildCatalog(), timeout])
    .then((entries) => {
      catalog.entries = entries;
      catalog.expiresAt = Date.now() + CATALOG_TTL_MS;
      catalog.connectionsVersion = version;
    })
    .catch(() => {
      // Keep whatever list we had and try again soon.
      catalog.expiresAt = Date.now() + CATALOG_RETRY_MS;
    })
    .finally(() => {
      clearTimeout(timer);
      catalog.refreshing = null;
    });
  return catalog.refreshing;
}

/**
 * The catalog as of the last refresh, never waiting on one. Upstream /models
 * calls can take tens of seconds, so a request finding the cache cold or stale
 * starts a background refresh and routes as if auto combos were off.
 */
function currentCatalog(): CatalogEntry[] {
  if (Date.now() >= catalog.expiresAt || catalog.connectionsVersion !== connectionsVersion()) void refreshCatalog();
  return catalog.entries || [];
}

/** Fill the catalog now. Used by tests and to warm it at startup. */
export async function warmAutoComboCatalog(): Promise<void> {
  catalog.expiresAt = 0;
  await refreshCatalog();
}

// Bare ids match catalog ids by their last path segment, with dots and case
// ignored, so "sfff/claude-opus-5.5" and "or/anthropic/claude-opus-5-5" both
// serve "claude-opus-5-5".
function modelKey(modelId: string): string {
  return modelId.toLowerCase().replace(/\./g, "-");
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : null;
}

interface AutoComboSettings {
  autoComboBlockedBilling?: unknown;
  autoComboExcludedProviders?: unknown;
}

/**
 * Every connected provider/model serving this bare id, in /v1/models order,
 * minus blocked billing sets and excluded providers.
 */
export async function getAutoComboModels(modelStr: string): Promise<string[]> {
  const bare = stripContextWindowSuffix(modelStr).model;
  if (!bare || bare.includes("/")) return [];
  // Right after startup there is no list yet. Give the first build a short
  // head start rather than sending that request down the old inferred route.
  if (catalog.entries === null || catalog.connectionsVersion !== connectionsVersion()) await Promise.race([refreshCatalog(), sleep(COLD_START_WAIT_MS)]);
  const entries = currentCatalog();
  if (entries.length === 0) return [];

  const settings = (await Promise.resolve().then(() => getSettings()).catch(() => ({}))) as AutoComboSettings;
  const blocked = new Set(stringList(settings.autoComboBlockedBilling) ?? DEFAULT_AUTO_COMBO_BLOCKED_BILLING);
  const excluded = new Set((stringList(settings.autoComboExcludedProviders) || []).map((p) => p.trim().toLowerCase()));
  const key = modelKey(bare);
  return entries
    .filter((e) => !blocked.has(e.billing))
    .filter((e) => !excluded.has(e.prefix.toLowerCase()) && !excluded.has(e.provider.toLowerCase()))
    .filter((e) => modelKey(e.id.slice(e.id.lastIndexOf("/") + 1)) === key)
    .map((e) => e.id);
}

/** Every catalog id serving this bare id, before any user filter. */
export function getAutoComboProviders(modelStr: string): string[] {
  const bare = stripContextWindowSuffix(modelStr).model;
  if (!bare || bare.includes("/")) return [];
  const key = modelKey(bare);
  return currentCatalog()
    .filter((e) => modelKey(e.id.slice(e.id.lastIndexOf("/") + 1)) === key)
    .map((e) => e.provider);
}

/**
 * The models to route a bare chat id across, or null to route it as before.
 * A combo or alias by that name, user-made or built in, always wins. Auto
 * combos are optional routing, so any failure here means "route as before".
 */
export async function resolveAutoCombo(modelStr: string, builtinAliases: Record<string, unknown> = {}): Promise<string[] | null> {
  try {
    const bare = stripContextWindowSuffix(modelStr).model;
    if (!bare || bare.includes("/") || builtinAliases[bare]) return null;
    const models = await getAutoComboModels(bare);
    if (models.length === 0) return null;
    if (await getComboByName(bare)) return null;
    const aliases = (await getModelAliases()) as Record<string, unknown> | null;
    return aliases?.[bare] ? null : models;
  } catch {
    return null;
  }
}

/** Normalize billing-set and provider lists from a settings PATCH. Null = reject. */
export function sanitizeAutoComboSetting(key: "autoComboBlockedBilling" | "autoComboExcludedProviders", value: unknown): string[] | null {
  const list = stringList(value);
  if (!list || list.length !== (value as unknown[]).length) return null;
  const trimmed = Array.from(new Set(list.map((v) => v.trim()).filter(Boolean)));
  if (key === "autoComboBlockedBilling") {
    return trimmed.every((v) => (AUTO_COMBO_BILLING_SETS as readonly string[]).includes(v)) ? trimmed : null;
  }
  return trimmed;
}
