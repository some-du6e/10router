import REGISTRY from "open-sse/providers/registry/index.js";
import { stripContextWindowSuffix } from "open-sse/services/model.js";
import { isModelLockActive } from "open-sse/services/accountFallback.js";
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

// Registry categories that misdescribe how a provider bills: these log in
// with OAuth but spend prepaid credits per token.
const BILLING_OVERRIDES: Record<string, BillingSet> = {
  cline: "payg",
  kilocode: "payg",
};

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
  testStatus?: string;
  errorCode?: number | string | null;
  providerSpecificData?: { prefix?: string };
  [lockKey: `modelLock_${string}`]: unknown;
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
  if (BILLING_OVERRIDES[entry.id]) return BILLING_OVERRIDES[entry.id];
  const byCategory = BILLING_BY_CATEGORY[entry.category || ""] || "payg";
  const authType = (conn.authType || "").toLowerCase().replace(/[-_]/g, "");
  if (byCategory === "subscription" && authType === "apikey") return "payg";
  return byCategory;
}

interface CatalogEntry {
  id: string;
  prefix: string;
  provider: string;
  // One per connection of the provider; a request may be served by any of them.
  billings: BillingSet[];
}

// Tried first to last, so free and flat-rate plans serve before anything metered.
const BILLING_ORDER: BillingSet[] = ["free", "subscription", "freeTier", "custom", "payg"];

// Edits that change the list bump the connections version, so the TTL only
// has to catch upstreams adding models; each rebuild calls every /models.
const CATALOG_TTL_MS = 5 * 60_000;
const CATALOG_RETRY_MS = 5_000;
// A build that timed out may still be running; give it time before another.
const CATALOG_TIMEOUT_RETRY_MS = 60_000;
// One slow upstream /models must not stall the refresh forever.
const CATALOG_BUILD_TIMEOUT_MS = 30_000;
const COLD_START_WAIT_MS = 3_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());

interface CatalogState {
  entries: CatalogEntry[] | null;
  expiresAt: number;
  refreshing: Promise<void> | null;
  refreshStartedAt: number;
  // Version the running (or last started) build reads; entries hold connectionsVersion.
  attemptedVersion: number;
  connectionsVersion: number;
}

// Bumped by the connections repo on every write; a change makes the catalog stale.
// The catalog lives on globalThis too: instrumentation and the route handlers
// are separate bundles, and the startup warm has to fill the copy routes read.
declare global {
  var _connectionsVersion: number | undefined;
  var _autoComboCatalog: CatalogState | undefined;
}
const connectionsVersion = () => globalThis._connectionsVersion || 0;

const catalog: CatalogState = (globalThis._autoComboCatalog ??= {
  entries: null, expiresAt: 0, refreshing: null, refreshStartedAt: 0, attemptedVersion: -1, connectionsVersion: -1,
});

// Loaded on first build; builds can overlap, so they share one import.
let modelsRoute: Promise<typeof import("@/app/api/v1/models/route.js")> | undefined;

async function buildCatalog(): Promise<CatalogEntry[]> {
  const conns = ((await getProviderConnections()) as Connection[]).filter((c) => c.isActive !== false);
  // With nothing connected, buildModelsList returns the whole static catalog,
  // which would build combos out of providers that have no credentials.
  if (conns.length === 0) return [];

  const billingsByProvider = new Map<string, Set<BillingSet>>();
  const providerByPrefix = new Map<string, string>();
  for (const c of conns) {
    if (!billingsByProvider.has(c.provider)) billingsByProvider.set(c.provider, new Set());
    billingsByProvider.get(c.provider)!.add(connectionBilling(c));
    const prefix = c.providerSpecificData?.prefix?.trim();
    if (prefix) providerByPrefix.set(prefix, c.provider);
  }

  const { buildModelsList } = await (modelsRoute ??= import("@/app/api/v1/models/route.js"));
  const list = (await buildModelsList(["llm"])) as { id?: string; owned_by?: string }[];
  const entries: CatalogEntry[] = [];
  for (const m of list) {
    if (m.owned_by === "combo" || typeof m.id !== "string" || !m.id.includes("/")) continue;
    const prefix = m.id.slice(0, m.id.indexOf("/"));
    const provider = providerByPrefix.get(prefix) || PROVIDER_ID_BY_KEY.get(prefix) || prefix;
    // No connection: a no-auth free provider still serves; anything else is unknown.
    const billings = billingsByProvider.get(provider) || new Set<BillingSet>([REGISTRY_BY_ID.get(provider)?.noAuth ? "free" : "custom"]);
    entries.push({ id: m.id, prefix, provider, billings: [...billings] });
  }
  return entries;
}

function refreshCatalog(): Promise<void> {
  const version = connectionsVersion();
  // A change made while a build runs needs a build that reads it.
  if (catalog.refreshing && catalog.attemptedVersion === version) return catalog.refreshing;
  catalog.attemptedVersion = version;
  catalog.refreshStartedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Error("catalog build timed out");
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timedOut), CATALOG_BUILD_TIMEOUT_MS);
  });
  // Builds can overlap, so only one at least as new as what we hold may land,
  // even if it finishes after timing out.
  const build = buildCatalog().then((entries) => {
    if (version < catalog.connectionsVersion) return;
    catalog.entries = entries;
    catalog.expiresAt = Date.now() + CATALOG_TTL_MS;
    catalog.connectionsVersion = version;
  });
  build.catch(() => {});
  const refreshing: Promise<void> = Promise.race([build, timeout])
    .catch((err: unknown) => {
      // Keep whatever list we had and try again later, unless a newer build began.
      if (catalog.attemptedVersion === version) {
        catalog.expiresAt = Date.now() + (err === timedOut ? CATALOG_TIMEOUT_RETRY_MS : CATALOG_RETRY_MS);
      }
    })
    .finally(() => {
      clearTimeout(timer);
      if (catalog.refreshing === refreshing) catalog.refreshing = null;
    });
  catalog.refreshing = refreshing;
  return refreshing;
}

/**
 * The catalog as of the last refresh, never waiting on one. Upstream /models
 * calls can take tens of seconds, so a request finding the cache cold or stale
 * starts a background refresh and routes as if auto combos were off. A build
 * that failed for the current version is retried only once its backoff ends.
 */
function currentCatalog(): CatalogEntry[] {
  if (Date.now() >= catalog.expiresAt || catalog.attemptedVersion !== connectionsVersion()) void refreshCatalog();
  return catalog.entries || [];
}

/** Fill the catalog now. Used by tests and to warm it at startup. */
export async function warmAutoComboCatalog(): Promise<void> {
  catalog.expiresAt = 0;
  catalog.attemptedVersion = -1;
  await refreshCatalog();
}

// Bare ids match catalog ids by their last path segment, with dots and case
// ignored, so "sfff/claude-opus-5.5" and "or/anthropic/claude-opus-5-5" both
// serve "claude-opus-5-5".
function modelKey(modelId: string): string {
  return modelId.toLowerCase().replace(/\./g, "-");
}

function sortByBilling(entries: CatalogEntry[], blocked: Set<string>): CatalogEntry[] {
  const rank = (e: CatalogEntry) => Math.min(...e.billings.filter((b) => !blocked.has(b)).map((b) => BILLING_ORDER.indexOf(b)));
  // Array.prototype.sort is stable, so /v1/models order breaks ties.
  return [...entries].sort((a, b) => rank(a) - rank(b));
}

// A rejected key outlives its lock: errorCode stays until a request succeeds.
const AUTH_FAILURE_CODES = new Set([401, 403]);

function connectionFailing(conn: Connection, model: string): boolean {
  if (isModelLockActive(conn, model)) return true;
  return conn.testStatus === "unavailable" && AUTH_FAILURE_CODES.has(Number(conn.errorCode));
}

/**
 * Move providers whose every usable connection is locked for the model or
 * rejected its credentials to the back, so a dead key stops costing each
 * request a failed attempt. They stay in as a last resort.
 */
async function demoteFailing(entries: CatalogEntry[], blocked: Set<string>): Promise<CatalogEntry[]> {
  let conns: Connection[];
  try {
    conns = ((await getProviderConnections()) as Connection[]).filter((c) => c.isActive !== false && !blocked.has(connectionBilling(c)));
  } catch {
    return entries;
  }
  const failing = entries.map((e) => {
    const own = conns.filter((c) => c.provider === e.provider);
    const model = e.id.slice(e.id.indexOf("/") + 1);
    return own.length > 0 && own.every((c) => connectionFailing(c, model));
  });
  return [...entries.filter((_, i) => !failing[i]), ...entries.filter((_, i) => failing[i])];
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : null;
}

interface AutoComboSettings {
  autoComboBlockedBilling?: unknown;
  autoComboExcludedProviders?: unknown;
  [key: string]: unknown;
}

async function loadSettings(settings?: AutoComboSettings): Promise<AutoComboSettings> {
  if (settings) return settings;
  return (await Promise.resolve().then(() => getSettings()).catch(() => ({}))) as AutoComboSettings;
}

/** Billing sets auto combos must not touch, from settings or the defaults. */
export function blockedBillingSets(settings: AutoComboSettings): Set<BillingSet> {
  return new Set((stringList(settings.autoComboBlockedBilling) ?? DEFAULT_AUTO_COMBO_BLOCKED_BILLING) as BillingSet[]);
}

function allowedEntries(entries: CatalogEntry[], settings: AutoComboSettings): CatalogEntry[] {
  const blocked = blockedBillingSets(settings);
  const excluded = new Set((stringList(settings.autoComboExcludedProviders) || []).map((p) => p.trim().toLowerCase()));
  return entries
    .filter((e) => e.billings.some((b) => !blocked.has(b)))
    .filter((e) => !excluded.has(e.prefix.toLowerCase()) && !excluded.has(e.provider.toLowerCase()));
}

/**
 * Every connected provider/model serving this bare id, free and flat-rate
 * first, failing providers last, minus blocked billing sets and excluded providers. A provider stays
 * in if any of its connections is allowed; the request then skips the blocked
 * ones (see blockedBillingSets).
 */
export async function getAutoComboModels(modelStr: string, settingsIn?: AutoComboSettings): Promise<string[]> {
  const bare = stripContextWindowSuffix(modelStr).model;
  if (!bare || bare.includes("/")) return [];
  // Right after startup or a connection change the list is missing or stale.
  // Give that build a short head start, counted from when it began, so a slow
  // build delays requests for a few seconds in total rather than each one.
  let entries = currentCatalog();
  if ((catalog.entries === null || catalog.connectionsVersion !== connectionsVersion()) && catalog.refreshing) {
    const left = catalog.refreshStartedAt + COLD_START_WAIT_MS - Date.now();
    if (left > 0) await Promise.race([catalog.refreshing, sleep(left)]);
    entries = catalog.entries || [];
  }
  if (entries.length === 0) return [];

  const settings = await loadSettings(settingsIn);
  const key = modelKey(bare);
  const matching = allowedEntries(entries, settings).filter((e) => modelKey(e.id.slice(e.id.lastIndexOf("/") + 1)) === key);
  const blocked = blockedBillingSets(settings);
  return (await demoteFailing(sortByBilling(matching, blocked), blocked)).map((e) => e.id);
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
export async function resolveAutoCombo(
  modelStr: string,
  builtinAliases: Record<string, unknown> = {},
  settings?: AutoComboSettings,
): Promise<string[] | null> {
  try {
    const bare = stripContextWindowSuffix(modelStr).model;
    if (!bare || bare.includes("/") || builtinAliases[bare]) return null;
    const models = await getAutoComboModels(bare, settings);
    if (models.length === 0) return null;
    if (await getComboByName(bare)) return null;
    const aliases = (await getModelAliases()) as Record<string, unknown> | null;
    return aliases?.[bare] ? null : models;
  } catch {
    return null;
  }
}

/**
 * Whether a request for this id has to stay off blocked billing sets even when
 * no auto combo forms (every provider blocked, or the catalog still cold). A
 * bare id without a user combo or alias would otherwise be routed by its name
 * alone, claude-* to Anthropic, gpt-* to OpenAI, straight onto a metered key.
 */
export async function billingPolicyApplies(modelStr: string, builtinAliases: Record<string, unknown> = {}): Promise<boolean> {
  const bare = stripContextWindowSuffix(modelStr).model;
  if (!bare || bare.includes("/") || builtinAliases[bare]) return false;
  try {
    if (await getComboByName(bare)) return false;
    const aliases = (await getModelAliases()) as Record<string, unknown> | null;
    return !aliases?.[bare];
  } catch {
    // Unsure means the safe side: the request may only use allowed accounts.
    return true;
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
