import REGISTRY from "open-sse/providers/registry/index.js";
import { stripContextWindowSuffix } from "open-sse/services/model.js";
import { getProviderConnections, getSettings, getModelAliases, getComboByName } from "@/lib/localDb";
import { connectionsVersion } from "@/lib/db/index.js";

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
// A list built while some provider's live catalog timed out holds that
// provider's static models (Zed has none, Kiro lacks per-account variants).
// It is rebuilt this soon, in the background, a few times in a row at most.
const PARTIAL_CATALOG_TTL_MS = 30_000;
const PARTIAL_REBUILDS = 3;
const CATALOG_RETRY_MS = 5_000;
// A build that timed out may still be running; give it time before another.
const CATALOG_TIMEOUT_RETRY_MS = 60_000;
// One slow upstream /models must not stall the refresh forever.
const CATALOG_BUILD_TIMEOUT_MS = 30_000;
// How long a request waits for the rebuild of a list that went stale.
const STALE_CATALOG_WAIT_MS = 3_000;
// Until the first list lands (right after a restart), a failed or timed-out
// build is retried this soon: requests are waiting on it.
const COLD_RETRY_MS = 2_000;
// The longest a request waits for that first list, and how many builds it
// sees fail before it stops waiting.
const COLD_WAIT_MS = CATALOG_BUILD_TIMEOUT_MS;
const COLD_MAX_FAILED_BUILDS = 3;

interface CatalogState {
  entries: CatalogEntry[] | null;
  expiresAt: number;
  refreshing: Promise<void> | null;
  refreshStartedAt: number;
  // Version the running (or last started) build reads; entries hold connectionsVersion.
  attemptedVersion: number;
  connectionsVersion: number;
  // Requests waiting for the catalog to change; see nextChange.
  waiters?: Set<() => void>;
  // The build running now, which a refresh for the same version joins rather
  // than starting another (a timed-out refresh leaves it running).
  build?: { version: number; promise: Promise<BuiltCatalog> } | null;
  // Builds that settled as failed or timed out, ever; see awaitFirstCatalog.
  failedBuilds?: number;
  // Partial lists landed in a row, and the background rebuild after one.
  partialStreak?: number;
  partialTimer?: ReturnType<typeof setTimeout> | null;
}

interface BuiltCatalog {
  entries: CatalogEntry[];
  // Some provider's live catalog timed out and its static models stand in.
  partial: boolean;
  // The prefixes (entry.prefix) of those providers.
  timedOut?: Set<string>;
}

/** Options for a request that may wait on the catalog. */
export interface CatalogWait {
  // The client's hang-up: stop waiting when it fires.
  signal?: AbortSignal | null;
  // Cap on the wait for the first list (default COLD_WAIT_MS).
  maxWaitMs?: number;
}

// The catalog lives on globalThis: instrumentation and the route handlers are
// separate bundles, and the startup warm has to fill the copy routes read.
declare global {
  var _autoComboCatalog: CatalogState | undefined;
}

const catalog: CatalogState = (globalThis._autoComboCatalog ??= {
  entries: null, expiresAt: 0, refreshing: null, refreshStartedAt: 0, attemptedVersion: -1, connectionsVersion: -1,
});

function notifyWaiters(): void {
  const waiters = catalog.waiters;
  if (!waiters?.size) return;
  catalog.waiters = new Set();
  for (const wake of waiters) wake();
}

// Resolves after `ms` or when `signal` aborts, and with `onChange` also when a
// build lands or a refresh settles, whichever comes first.
function nextChange(ms: number, signal?: AbortSignal | null, { onChange = true } = {}): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const waiters = (catalog.waiters ??= new Set());
    const wake = () => {
      clearTimeout(timer);
      waiters.delete(wake);
      signal?.removeEventListener("abort", wake);
      resolve();
    };
    const timer = setTimeout(wake, Math.max(0, ms));
    timer.unref?.();
    if (onChange) waiters.add(wake);
    signal?.addEventListener("abort", wake, { once: true });
  });
}

// Loaded on first build; builds can overlap, so they share one import.
let modelsRoute: Promise<typeof import("@/app/api/v1/models/route.js")> | undefined;

async function buildCatalog(): Promise<BuiltCatalog> {
  const conns = ((await getProviderConnections()) as Connection[]).filter((c) => c.isActive !== false);
  // With nothing connected, buildModelsList returns the whole static catalog,
  // which would build combos out of providers that have no credentials.
  if (conns.length === 0) return { entries: [], partial: false };

  const billingsByProvider = new Map<string, Set<BillingSet>>();
  const providerByPrefix = new Map<string, string>();
  for (const c of conns) {
    if (!billingsByProvider.has(c.provider)) billingsByProvider.set(c.provider, new Set());
    billingsByProvider.get(c.provider)!.add(connectionBilling(c));
    const prefix = c.providerSpecificData?.prefix?.trim();
    if (prefix) providerByPrefix.set(prefix, c.provider);
  }

  const { buildModelsList } = await (modelsRoute ??= import("@/app/api/v1/models/route.js"));
  let partial = false;
  const timedOut = new Set<string>();
  const onLiveTimeout = (_providerId: string, { alias }: { alias?: string } = {}) => {
    partial = true;
    if (alias) timedOut.add(alias);
  };
  const list = (await buildModelsList(["llm"], { onLiveTimeout })) as { id?: string; owned_by?: string }[];
  const entries: CatalogEntry[] = [];
  for (const m of list) {
    if (m.owned_by === "combo" || typeof m.id !== "string" || !m.id.includes("/")) continue;
    const prefix = m.id.slice(0, m.id.indexOf("/"));
    const provider = providerByPrefix.get(prefix) || PROVIDER_ID_BY_KEY.get(prefix) || prefix;
    // No connection: a no-auth free provider still serves; anything else is unknown.
    const billings = billingsByProvider.get(provider) || new Set<BillingSet>([REGISTRY_BY_ID.get(provider)?.noAuth ? "free" : "custom"]);
    entries.push({ id: m.id, prefix, provider, billings: [...billings] });
  }
  return { entries, partial, timedOut };
}

function land({ entries, partial, timedOut }: BuiltCatalog, version: number): void {
  // A provider whose live catalog timed out keeps what the held list had for
  // it: its static models are a worse guess (Zed has none, Kiro lacks its
  // per-account variants). Every provider that answered is replaced. With no
  // list held yet (cold start), the static models are all there is.
  const held = catalog.entries;
  catalog.entries = partial && held && timedOut?.size
    ? [...entries.filter((e) => !timedOut.has(e.prefix)), ...held.filter((e) => timedOut.has(e.prefix))]
    : entries;
  catalog.connectionsVersion = version;
  if (catalog.partialTimer) clearTimeout(catalog.partialTimer);
  catalog.partialTimer = null;
  const streak = partial ? (catalog.partialStreak ?? 0) + 1 : 0;
  catalog.partialStreak = streak;
  const rebuildSoon = partial && streak <= PARTIAL_REBUILDS;
  catalog.expiresAt = Date.now() + (rebuildSoon ? PARTIAL_CATALOG_TTL_MS : CATALOG_TTL_MS);
  if (rebuildSoon) {
    // Without waiting for a request: the slow provider's real list should be
    // in place before anyone asks for one of its models.
    catalog.partialTimer = setTimeout(() => {
      catalog.partialTimer = null;
      void refreshCatalog();
    }, PARTIAL_CATALOG_TTL_MS);
    catalog.partialTimer.unref?.();
  }
  // Whichever build lands first serves the requests waiting for a list.
  notifyWaiters();
}

// The build for `version`: the one already running for it, or a new one.
// Builds can overlap, so only one at least as new as what we hold may land,
// even if it finishes after its refresh timed out.
function buildFor(version: number): Promise<BuiltCatalog> {
  if (catalog.build && catalog.build.version === version) return catalog.build.promise;
  const promise = buildCatalog().then((built) => {
    if (version >= catalog.connectionsVersion) land(built, version);
    return built;
  });
  const running = { version, promise };
  catalog.build = running;
  promise.catch(() => {}).finally(() => {
    if (catalog.build === running) catalog.build = null;
  });
  return promise;
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
  const refreshing: Promise<void> = Promise.race([buildFor(version), timeout])
    .then(() => {})
    .catch((err: unknown) => {
      catalog.failedBuilds = (catalog.failedBuilds ?? 0) + 1;
      // Keep whatever list we had and try again later, unless a newer build began.
      if (catalog.attemptedVersion === version) {
        const backoff = catalog.entries === null ? COLD_RETRY_MS : err === timedOut ? CATALOG_TIMEOUT_RETRY_MS : CATALOG_RETRY_MS;
        catalog.expiresAt = Date.now() + backoff;
      }
    })
    .finally(() => {
      clearTimeout(timer);
      if (catalog.refreshing === refreshing) catalog.refreshing = null;
      notifyWaiters();
    });
  catalog.refreshing = refreshing;
  return refreshing;
}

/**
 * The catalog as of the last refresh, never waiting on one. A request finding
 * the cache cold (never built) or stale starts a background refresh, and
 * getAutoComboModels decides how long it waits: for a cold one until a list
 * lands, for a stale one a few seconds, since upstream /models calls can take
 * tens of seconds. A build that failed for the current version is retried only
 * once its backoff ends, which is short while the cache is cold.
 */
function currentCatalog(): CatalogEntry[] {
  if (Date.now() >= catalog.expiresAt || catalog.attemptedVersion !== connectionsVersion()) void refreshCatalog();
  return catalog.entries || [];
}

/**
 * Wait for the first list, starting a build whenever none runs and the short
 * cold backoff is over. Returns when a list lands, after `waitMs`, or when the
 * client hangs up.
 */
async function awaitFirstCatalog(waitMs: number, signal?: AbortSignal | null): Promise<void> {
  const deadline = Date.now() + waitMs;
  const failedBefore = catalog.failedBuilds ?? 0;
  while (catalog.entries === null && !signal?.aborted) {
    const left = deadline - Date.now();
    if (left <= 0) return;
    // A build that keeps failing would otherwise hold every bare-id request
    // for the whole wait. Only builds that settled as failed or timed out
    // count, not one still running.
    if ((catalog.failedBuilds ?? 0) - failedBefore >= COLD_MAX_FAILED_BUILDS) return;
    currentCatalog();
    const backoffLeft = catalog.refreshing ? left : catalog.expiresAt - Date.now();
    await nextChange(Math.min(left, Math.max(10, backoffLeft)), signal);
  }
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
 * first, minus blocked billing sets and excluded providers. A provider stays
 * in if any of its connections is allowed; the request then skips the blocked
 * ones (see blockedBillingSets).
 */
export async function getAutoComboModels(modelStr: string, settingsIn?: AutoComboSettings, wait: CatalogWait = {}): Promise<string[]> {
  const bare = stripContextWindowSuffix(modelStr).model;
  if (!bare || bare.includes("/")) return [];
  let entries = currentCatalog();
  if (catalog.entries === null) {
    // No list yet: the server just started. A bare id that only an auto combo
    // serves would fail as an unknown model without one, so wait for a list.
    await awaitFirstCatalog(wait.maxWaitMs ?? COLD_WAIT_MS, wait.signal);
    entries = catalog.entries || [];
  } else if (catalog.connectionsVersion !== connectionsVersion() && catalog.refreshing) {
    // A connection change made the list stale. Give the rebuild a short head
    // start, counted from when it began, so a slow build delays requests for
    // a few seconds in total rather than each one. Only that newest build
    // counts: an older one landing would serve the list before the change.
    const left = catalog.refreshStartedAt + STALE_CATALOG_WAIT_MS - Date.now();
    if (left > 0) await Promise.race([catalog.refreshing, nextChange(left, wait.signal, { onChange: false })]);
    entries = catalog.entries || [];
  }
  if (entries.length === 0) return [];

  const settings = await loadSettings(settingsIn);
  const key = modelKey(bare);
  const matching = allowedEntries(entries, settings).filter((e) => modelKey(e.id.slice(e.id.lastIndexOf("/") + 1)) === key);
  return sortByBilling(matching, blockedBillingSets(settings)).map((e) => e.id);
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
 * A combo or alias by that name, user-made or built in, always wins, and is
 * looked up first so it never waits on a cold catalog. Auto combos are
 * optional routing, so any failure here means "route as before".
 */
export async function resolveAutoCombo(
  modelStr: string,
  builtinAliases: Record<string, unknown> = {},
  settings?: AutoComboSettings,
  wait: CatalogWait = {},
): Promise<string[] | null> {
  try {
    const bare = stripContextWindowSuffix(modelStr).model;
    if (!bare || bare.includes("/") || builtinAliases[bare]) return null;
    if (await getComboByName(bare)) return null;
    const aliases = (await getModelAliases()) as Record<string, unknown> | null;
    if (aliases?.[bare]) return null;
    const models = await getAutoComboModels(bare, settings, wait);
    return models.length === 0 ? null : models;
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
