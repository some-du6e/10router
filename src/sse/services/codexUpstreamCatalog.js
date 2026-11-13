/**
 * Codex's own model catalog, read from the ChatGPT backend with a connected
 * Codex account. The router's `/backend-api/codex/models` reuses these entries
 * for the models Codex knows, so they keep the prompt and tools Codex would
 * give them talking to ChatGPT directly.
 *
 * Cached per Codex version: the backend shapes entries for the client_version
 * it is asked for, and an entry built for a newer Codex can carry values an
 * older one can't decode. Requests never wait long for it: a cold cache waits
 * a moment, then goes without, and a stale one is served while it refreshes.
 * Tokens are never refreshed here (refresh tokens rotate); an expired account
 * is skipped and the background token refresh brings it back.
 */

import { getProviderConnections } from "@/lib/localDb";

// The /codex/models endpoint gates each entry by minimal_client_version against this
// value, and codex CLI's own manifest (openai/codex codex-rs/models-manager/models.json)
// already requires 0.144.0 for its newest models, so a stale client_version here comes
// back 200 with those entries quietly missing instead of erroring.
export const CODEX_CLIENT_VERSION = "0.144.6";
const CODEX_MODELS_ENDPOINT = "https://chatgpt.com/backend-api/codex/models";

const FRESH_MS = 10 * 60_000;
const RETRY_MS = 60_000;
const FETCH_TIMEOUT_MS = 4_000;
// Codex gives up on its catalog request after 5 seconds.
const COLD_WAIT_MS = 2_000;
const MAX_ACCOUNTS_TRIED = 3;
const MAX_VERSIONS = 8;

const state = globalThis[Symbol.for("10router.codexUpstreamCatalog")] ||= {
  byVersion: new Map(),
};

export const codexModelsUrl = (clientVersion = CODEX_CLIENT_VERSION) =>
  `${CODEX_MODELS_ENDPOINT}?client_version=${encodeURIComponent(clientVersion)}`;

export function fetchCodexModels(accessToken, clientVersion = CODEX_CLIENT_VERSION, { signal } = {}) {
  return fetch(codexModelsUrl(clientVersion), {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Authorization": `Bearer ${accessToken}`,
      "originator": "codex_cli_rs",
    },
    signal,
  });
}

export function normalizeClientVersion(value) {
  return typeof value === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(value)
    ? value
    : CODEX_CLIENT_VERSION;
}

const isUsable = (connection, now) => {
  if (connection?.provider !== "codex" || connection.isActive === false || !connection.accessToken) return false;
  const expiresAt = connection.expiresAt || connection.tokenExpiresAt;
  return !expiresAt || new Date(expiresAt).getTime() > now;
};

const isCatalog = (body) => Array.isArray(body?.models)
  && body.models.length > 0
  && body.models.every((m) => typeof m?.slug === "string" && m.slug.trim() !== "");

async function fetchFromAccounts(clientVersion) {
  let connections = [];
  try {
    connections = await getProviderConnections();
  } catch {
    return null;
  }
  const now = Date.now();
  const usable = connections.filter((c) => isUsable(c, now)).slice(0, MAX_ACCOUNTS_TRIED);
  for (const connection of usable) {
    try {
      const response = await fetchCodexModels(connection.accessToken, clientVersion, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) continue;
      const body = await response.json();
      if (isCatalog(body)) return body.models;
    } catch {
      // Try the next account.
    }
  }
  return null;
}

function slotFor(version) {
  let slot = state.byVersion.get(version);
  if (slot) return slot;
  if (state.byVersion.size >= MAX_VERSIONS) {
    state.byVersion.delete(state.byVersion.keys().next().value);
  }
  slot = { models: null, refreshAt: 0, inflight: null };
  state.byVersion.set(version, slot);
  return slot;
}

function refresh(slot, version) {
  if (slot.inflight) return slot.inflight;
  slot.inflight = fetchFromAccounts(version)
    .then((models) => {
      if (models) slot.models = models;
      slot.refreshAt = Date.now() + (models ? FRESH_MS : RETRY_MS);
    })
    .catch(() => {
      slot.refreshAt = Date.now() + RETRY_MS;
    })
    .finally(() => {
      slot.inflight = null;
    });
  return slot.inflight;
}

/**
 * Codex catalog entries from the ChatGPT backend for this Codex version, or
 * `[]` when no Codex account is connected or the backend can't be reached.
 * @param {string} [clientVersion] the `client_version` Codex sent
 * @returns {Promise<object[]>}
 */
export async function getCodexUpstreamModels(clientVersion) {
  const version = normalizeClientVersion(clientVersion);
  const slot = slotFor(version);
  if (Date.now() >= slot.refreshAt) refresh(slot, version);
  if (slot.models) return slot.models;
  if (slot.inflight) {
    let timer;
    await Promise.race([
      slot.inflight,
      new Promise((resolve) => { timer = setTimeout(resolve, COLD_WAIT_MS); timer.unref?.(); }),
    ]);
    clearTimeout(timer);
  }
  return slot.models || [];
}

export function resetCodexUpstreamCatalog() {
  state.byVersion.clear();
}
