import { readJsonObject, missingModel } from "../utils/requestBody.js";
import {
  extractApiKey, isValidApiKey,
  getProviderCredentials, markAccountUnavailable, clearAccountError,
} from "../services/auth.js";
import { allLockedError } from "open-sse/utils/limitHold.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo, getComboModels, comboLookupName } from "../services/model.js";
import { handleTtsCore } from "open-sse/handlers/ttsCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { modelIdProblem } from "open-sse/utils/modelPath.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { handleComboChat } from "open-sse/services/combo.js";
import * as log from "../utils/logger.js";
import { checkApiKeyLimits } from "../services/keyLimits.js";

// Derived from providers.js: any TTS provider not noAuth requires stored credentials
const CREDENTIALED_PROVIDERS = new Set(
  Object.entries(AI_PROVIDERS)
    .filter(([, p]) => p.serviceKinds?.includes("tts") && !p.noAuth && p.ttsConfig?.authType !== "none")
    .map(([id]) => id)
);

// OpenAI's speech formats, plus `json` (base64 audio in a JSON body). The value
// ends up in the reply's Content-Type, so nothing else gets through.
const RESPONSE_FORMATS = ["mp3", "opus", "aac", "flac", "wav", "pcm", "json"];

export async function handleTts(request) {
  const { body, error } = await readJsonObject(request, { logTag: "TTS" });
  if (error) return error;

  const url = new URL(request.url);
  const modelStr = body.model;
  // The query parameter (the dashboard sends it) wins over the body's, which is
  // where API clients put it. An empty query value falls through to the body.
  const requestedFormat = url.searchParams.get("response_format") || body.response_format;
  const language = body.language || ""; // Optional language hint (currently used by Gemini)
  const style = body.style || ""; // Optional style/voice instructions (e.g. Xiaomi MiMo)
  log.request("POST", `${url.pathname} | ${modelStr} | format=${requestedFormat ?? "mp3"}${language ? ` | lang=${language}` : ""}`);

  const settings = await getSettings();
  const apiKey = extractApiKey(request);
  if (settings.requireApiKey) {
    if (!apiKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    const valid = await isValidApiKey(apiKey);
    if (!valid) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  }

  if (requestedFormat != null && (typeof requestedFormat !== "string" || !requestedFormat.trim())) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "response_format must be a non-empty string");
  }
  const responseFormat = requestedFormat == null ? "mp3" : requestedFormat.trim().toLowerCase();
  if (!RESPONSE_FORMATS.includes(responseFormat)) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `response_format must be one of ${RESPONSE_FORMATS.join(", ")}`);
  }

  const noModel = missingModel(modelStr, "TTS");
  if (noModel) return noModel;
  if (typeof body.input !== "string" || !body.input.trim()) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: input");
  const limitDenied = await checkApiKeyLimits(apiKey, { model: modelStr });
  if (limitDenied) return limitDenied;

  // Combo expansion: model may be a combo name → run fallback/round-robin across models
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    // Combos are configured and rotation-tracked under the bare name.
    const comboKey = comboLookupName(modelStr);
    const comboStrategies = settings.comboStrategies || {};
    const comboStrategy = comboStrategies[comboKey]?.fallbackStrategy || settings.comboStrategy || "fallback";
    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("TTS", `Combo "${comboKey}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (b, m) => handleSingleModelTts(b, m, responseFormat, language, style),
      log,
      comboName: comboKey,
      comboStrategy,
      comboStickyLimit,
    });
  }

  return handleSingleModelTts(body, modelStr, responseFormat, language, style);
}

async function handleSingleModelTts(body, modelStr, responseFormat, language, style) {
  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");

  const { provider, model } = modelInfo;
  // Refused before any account is tried, so it locks none.
  const badModel = modelIdProblem(model, { segments: true });
  if (badModel) return errorResponse(HTTP_STATUS.BAD_REQUEST, badModel);
  log.info("ROUTING", `Provider: ${provider}, Voice: ${model}`);

  // noAuth providers — no credential needed
  if (!CREDENTIALED_PROVIDERS.has(provider)) {
    const result = await handleTtsCore({ provider, model, input: body.input, responseFormat, language, style });
    if (result.success) return result.response;
    return errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "TTS failed");
  }

  // Credentialed providers — fallback loop (same pattern as embeddings)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model);

    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const { status, error } = allLockedError(lastStatus, lastError, credentials);
        const msg = error || "Unavailable";
        return unavailableResponse(status, `[${provider}/${model}] ${msg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    log.info("AUTH", `\x1b[32mUsing ${provider} account: ${credentials.connectionName}\x1b[0m`);

    const result = await handleTtsCore({ provider, model, input: body.input, credentials, responseFormat, language, style });

    if (result.success) {
      await clearAccountError(credentials.connectionId, credentials, model)
        .catch((error) => log.warn("AUTH", `Could not clear ${credentials.connectionName} errors: ${error.message}`));
      return result.response;
    }
    // This connection's server rejected the request. Another connection may be
    // a different server (self-hosted ones each have their own baseUrl), so try
    // it, but lock none: the request, not the account, was at fault. When none
    // is left, the loop above answers with this 400.
    if (result.upstreamRejected) {
      // A connection that can't be excluded would come back forever.
      if (!credentials.connectionId || excludeConnectionIds.has(credentials.connectionId)) return result.response;
      log.warn("AUTH", `${credentials.connectionName} rejected the request [${result.status}], not locking`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }
    // handleTtsCore's own 400s (no input, provider without TTS) are the same
    // on every account.
    if (result.status === HTTP_STATUS.BAD_REQUEST) return result.response;

    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, null, credentials.apiKey);
    if (shouldFallback) {
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }
    return result.response || errorResponse(result.status, result.error);
  }
}
