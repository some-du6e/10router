import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { handleAntigravityQuotaError, clearAntigravityStrikes } from "../services/antigravityQuota.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo, getComboModels, comboLookupName } from "../services/model.js";
import { handleChatCore, clientReceivesStream } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { createLimitHoldResponse, awaitLimitClear, isLimitError } from "open-sse/utils/limitHold.js";
import { resolveLimitHold } from "../services/limitHoldConfig.js";
import { handleComboChat, handleFusionChat, detectRequiredCapabilities } from "open-sse/services/combo.js";
import { augmentModelsWithCapacityAdapter, withCapacityAdapterStripping, getActiveAdapterStrategy } from "open-sse/services/capacityAdapter.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import { detectFormat } from "open-sse/services/provider.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { enrichClaudeBuiltinSearch } from "../services/claudeBuiltinSearch.js";
import { summarizeAccountFailures } from "../services/accountFailureSummary.js";
import {
  isAffinityProvider,
  affinityKeyFor,
  getAffinity,
  bindAffinity,
  releaseAffinity,
} from "open-sse/services/sessionAffinity.js";
import { stripModelContextMarker } from "open-sse/utils/modelMarkers.js";

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  // Claude Code marks a 1M-context request as `<model>[1m]`; the marker matches
  // no combo, alias or provider/model pair, so it must not reach resolution.
  // The capability travels in the anthropic-beta header, forwarded as-is.
  const { model: modelStr, contextMarker } = stripModelContextMarker(body.model);
  if (contextMarker) body.model = modelStr;

  // Request summary is emitted as the unified "▶" line in chatCore (has fmt/thinking/account)

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  const sourceFormatOverride = request?.url
    ? detectFormatByEndpoint(new URL(request.url).pathname, body)
    : null;

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming, sourceFormatOverride);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  const requiredCapabilities = detectRequiredCapabilities(body);

  // Check if model is a combo (has multiple models with fallback)
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    // Combos are configured and rotation-tracked under the bare name, so a
    // context-window selector must not fragment either.
    const comboKey = comboLookupName(modelStr);
    // Check for combo-specific strategy first, fallback to global
    const comboStrategies = settings.comboStrategies || {};
    const comboSpecificStrategy = comboStrategies[comboKey]?.fallbackStrategy;
    const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";
    const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, settings);
    const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

    if (comboStrategy === "fusion") {
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
      return handleFusionChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m, isPanel) => {
          let cleanRawReq = clientRawRequest;
          if (isPanel && clientRawRequest) {
            const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
            cleanRawReq = { ...clientRawRequest, body: cleanBody };
          }
          return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, { allowHold: false });
        },
        log,
        comboName: comboKey,
        judgeModel: comboStrategies[comboKey]?.judgeModel,
        tuning: comboStrategies[comboKey]?.fusionTuning,
      });
    }

    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: augmentedModels,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, { allowHold: false }),
        adapterAdded
      ),
      log,
      comboName: comboKey,
      comboStrategy,
      comboStickyLimit
    });
  }

  // Single model request — may still switch to a capacity-adapter model if the
  // target lacks a capability the request needs (e.g. no vision, request has an image).
  const soloAugmented = augmentModelsWithCapacityAdapter([modelStr], requiredCapabilities, settings);
  if (soloAugmented.length > 1) {
    const adapterAdded = soloAugmented.filter((m) => m !== modelStr);
    log.info("CHAT", `Capacity adapter for [${[...requiredCapabilities].join(",")}] on "${modelStr}" → trying ${soloAugmented.join(", ")}`);
    return handleComboChat({
      body,
      models: soloAugmented,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, { allowHold: false }),
        adapterAdded
      ),
      log,
      comboName: comboLookupName(modelStr),
      comboStrategy: getActiveAdapterStrategy(requiredCapabilities, settings)
    });
  }

  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey);
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, { allowHold = true } = {}) {
  // Detect source format by endpoint + body (scoped per-call; handleChat's copy is a
  // separate function and is not visible here)
  const sourceFormatOverride = request?.url
    ? detectFormatByEndpoint(new URL(request.url).pathname, body)
    : null;
  const modelInfo = await getModelInfo(modelStr);

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      const chatSettings = await getSettings();
      // Check for combo-specific strategy first, fallback to global
      const comboKey = comboLookupName(modelStr);
      const comboStrategies = chatSettings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[comboKey]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || chatSettings.comboStrategy || "fallback";
      const requiredCapabilities = detectRequiredCapabilities(body);
      const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, chatSettings);
      const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
        return handleFusionChat({
          body,
          models: comboModels,
          handleSingleModel: (b, m, isPanel) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, { allowHold: false });
          },
          log,
          comboName: comboKey,
          judgeModel: comboStrategies[comboKey]?.judgeModel,
          tuning: comboStrategies[comboKey]?.fusionTuning,
        });
      }

      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: augmentedModels,
        handleSingleModel: withCapacityAdapterStripping(
          (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, { allowHold: false }),
          adapterAdded
        ),
        log,
        comboName: comboKey,
        comboStrategy,
        comboStickyLimit
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;

  body = await enrichClaudeBuiltinSearch(body, { provider, request, apiKey, log });

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Session→account affinity (Codex only, opt-in). A Codex conversation keeps a
  // stable prompt_cache_key across turns, but the upstream prompt cache is
  // per-account — so re-picking an account per turn throws that cache away.
  // Pinning the session to one account is what makes the key pay off.
  //
  // Resolved before the loop so a retry after a failed account still knows the
  // session, and skipped entirely (no settings read) for every other provider.
  let affinityKey = null;
  if (isAffinityProvider(provider)) {
    const affinitySettings = await getSettings();
    if (affinitySettings.codexSessionAffinity) {
      affinityKey = affinityKeyFor({ provider, headers: request?.headers, body });
    }
  }

  // Rate-limit hold: when every account is limited we can keep the client's
  // stream open and wait for the reset instead of returning an error.
  const limitHold = allowHold ? await resolveLimitHold(apiKey) : { enabled: false, onPinned: false };

  // One full pass over the available accounts. Returns a structured result so a
  // limit can be retried later by the hold, rather than being burned into a
  // Response the caller can no longer act on.
  const runAccountLoop = async () => {
  // Fresh per pass: a retry after the reset must reconsider every account, not
  // inherit exclusions from the pass that ran hours ago.
  const excludeConnectionIds = new Set();
  const accountFailures = [];
  let lastError = null;
  let lastStatus = null;

  while (true) {
    // A pin is a preference, not a requirement: getProviderCredentials ignores a
    // connection that is excluded, model-locked or rate-limited and falls back to
    // the configured strategy, so a dead pinned account never wedges a session.
    const preferredConnectionId = affinityKey ? getAffinity(affinityKey) : null;
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, { preferredConnectionId });

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = accountFailures.length > 0
          ? summarizeAccountFailures(provider, model, accountFailures)
          : (lastError || credentials.lastError || "Unavailable");
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        const prefixedError = accountFailures.length > 0 ? errorMsg : `[${provider}/${model}] ${errorMsg}`;
        log.warn("CHAT", `${prefixedError} (${credentials.retryAfterHuman})`);
        const retryAtMs = credentials.retryAfter ? new Date(credentials.retryAfter).getTime() : 0;
        return {
          success: false,
          status,
          error: errorMsg,
          limited: isLimitError(status, errorMsg),
          retryAtMs,
          response: unavailableResponse(status, prefixedError, credentials.retryAfter, credentials.retryAfterHuman),
        };
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return { success: false, status: HTTP_STATUS.NOT_FOUND, error: `No active credentials for provider: ${provider}`, response: errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`) };
      }
      log.warn("CHAT", "No more accounts available", { provider });
      const status = lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE;
      const errorMsg = summarizeAccountFailures(provider, model, accountFailures);
      return { success: false, status, error: errorMsg, response: errorResponse(status, errorMsg) };
    }

    // Bind before the turn runs, not after it succeeds: Codex fires side
    // requests concurrently with the main turn, and they should land on the same
    // account rather than racing to claim the session.
    if (affinityKey && credentials.connectionId) bindAffinity(affinityKey, credentials.connectionId);

    // Account selection shown in the unified "▶" line (acc:...)
    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken, provider);
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    // Use shared chatCore
    const chatSettings = await getSettings();
    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
    const result = await handleChatCore({
      body: { ...body, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      clientRawRequest,
      connectionId: credentials.connectionId,
      userAgent,
      apiKey,
      ccFilterNaming: !!chatSettings.ccFilterNaming,
      rtkEnabled: !!chatSettings.rtkEnabled,
      headroomEnabled: !!chatSettings.headroomEnabled,
      headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
      headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
      headroomTimeoutMs: chatSettings.headroomTimeoutMs,
      cavemanEnabled: !!chatSettings.cavemanEnabled,
      cavemanLevel: chatSettings.cavemanLevel || "full",
      ponytailEnabled: !!chatSettings.ponytailEnabled,
      ponytailLevel: chatSettings.ponytailLevel || "full",
      pxpipeEnabled: !!chatSettings.pxpipeEnabled,
      pxpipeMinChars: chatSettings.pxpipeMinChars,
      pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
      // Lazily warms the in-process module on first use; null when not installed (fail-open)
      pxpipeTransform: chatSettings.pxpipeEnabled ? await getPxpipeTransform() : null,
      onPxpipeEvent: appendPxpipeEvent,
      providerThinking,
      sourceFormatOverride,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          ...newCreds,
          existingProviderSpecificData: credentials.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
        // "Consecutive" strikes: a success clears the breaker for this pair.
        clearAntigravityStrikes(credentials.connectionId, model);
      }
    });

    if (result.success) return result;

    // Refresh Antigravity quota before deciding how long to lock the account.
    let quotaResetMs = null;
    let resetsAtMs = result.resetsAtMs;
    if (provider === "antigravity" && (result.status === 409 || result.status === 429)) {
      quotaResetMs = await handleAntigravityQuotaError(
        credentials.connectionId, result.status, model,
        refreshedCredentials.accessToken, credentials.providerSpecificData
      );
      if (quotaResetMs) resetsAtMs = quotaResetMs;
    }

    let shouldFallback = true;
    let cooldownMs = 0;
    if (!(provider === "antigravity" && quotaResetMs)) {
      ({ shouldFallback, cooldownMs } = await markAccountUnavailable(
        credentials.connectionId, result.status, result.error, provider, model, resetsAtMs
      ));
    }

    // Hold for the pinned account rather than rotating away from it. Opt-in:
    // rotating is instant, so waiting only pays when prompt-cache continuity is
    // worth more than the delay.
    if (
      shouldFallback &&
      limitHold.enabled &&
      limitHold.onPinned &&
      affinityKey &&
      getAffinity(affinityKey) === credentials.connectionId &&
      isLimitError(result.status, result.error)
    ) {
      log.warn("LIMITHOLD", `pinned ACC:${credentials.connectionName} limited — holding instead of rotating`);
      return {
        success: false,
        status: result.status,
        error: result.error,
        limited: true,
        retryAtMs: resetsAtMs || Date.now() + (cooldownMs || 0),
        response: result.response,
      };
    }

    if (shouldFallback) {
      log.warn("FALLBACK", `⇄ ACC:${credentials.connectionName} UNAVAILABLE (${result.status}) → NEXT ACCOUNT`);
      accountFailures.push({
        account: credentials.connectionName,
        status: result.status,
        error: result.error,
      });
      // Stale-anchor recovery: the pinned account just went away, so drop the pin
      // and let the next iteration rebind. Guarded on the id, so a concurrent turn
      // that already moved the session elsewhere is left alone.
      if (affinityKey) releaseAffinity(affinityKey, credentials.connectionId);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return result;
  }
  };

  const first = await runAccountLoop();
  if (first.success) return first.response;

  if (!first.limited || !limitHold.enabled) return first.response;

  // Non-streaming clients have no stream to narrate into, so the request just
  // hangs until the limit clears and the real JSON comes back. `body.stream`
  // alone is not the answer — an Accept: application/json client (AI SDK) or
  // deepseek-tui resolves to JSON without ever setting it, and handing those an
  // SSE banner would break a request that used to return a clean error.
  const holdSourceFormat = sourceFormatOverride || detectFormat(body);
  const willStream = clientReceivesStream({ body, provider, model, sourceFormat: holdSourceFormat, clientRawRequest });
  if (!willStream) {
    const abort = new AbortController();
    request?.signal?.addEventListener?.("abort", () => abort.abort(), { once: true });
    const settled = await awaitLimitClear({
      retryAtMs: first.retryAtMs,
      attempt: runAccountLoop,
      provider,
      model,
      signal: abort.signal,
      log,
    });
    return settled?.response || first.response;
  }

  return createLimitHoldResponse({
    sourceFormat: holdSourceFormat,
    model: modelStr,
    provider,
    retryAtMs: first.retryAtMs,
    attempt: runAccountLoop,
    log,
  });
}
