import { createHash } from "crypto";
import { clientDemandsJson } from "../utils/replyShape.js";
import { detectFormat, getTargetFormat, resolveTransport, resolveCompatibleRoute } from "../services/provider.js";
import { translateRequest } from "../translator/index.js";
import { applyThinking, extractThinking, stripThinkingSuffix } from "../translator/concerns/thinkingUnified.js";
import { FORMATS } from "../translator/formats.js";
import { normalizeClaudePassthrough, anchorClaudeCache } from "../translator/formats/claude.js";
import { createStreamController } from "../utils/streamHandler.js";
import { refreshWithRetry } from "../services/tokenRefresh.js";
import { applyRefreshedCredentials } from "../services/oauthCredentialManager.js";
import { createRequestLogger } from "../utils/requestLogger.js";
import { getModelTargetFormat, getModelSupportedFormats, getModelStrip, getModelUpstreamId, getModelType, PROVIDER_ID_TO_ALIAS } from "../config/providerModels.js";
import { PROVIDERS } from "../config/providers.js";
import { createErrorResult, parseUpstreamError, formatProviderError, isClientAbort, clientAbortResult } from "../utils/error.js";
import { isUpstreamHeadersTimeout } from "../utils/headersTimeout.js";
import { classifyError, classifyThrownError } from "../utils/errorClass.js";
import { HTTP_STATUS, STREAM_DRAIN_MAX_MS } from "../config/runtimeConfig.js";
import { handleBypassRequest } from "../utils/bypassHandler.js";
import { injectLimitHoldNotice } from "../utils/limitHoldNotice.js";
import { trackPendingRequest, appendRequestLog, saveRequestDetail } from "@/lib/usageDb.js";
import { getExecutor } from "../executors/index.js";
import { supportsGrokCliReasoningEffort } from "../config/grokCli.js";
import { buildRequestDetail, extractRequestConfig, saveUsageStats } from "./chatCore/requestDetail.js";
import { hangUpUsage } from "../utils/hangUpCharge.js";
import { THINKING_OBJECT_KEYS, HISTORY_KEYS, ITEM_LIST_KEYS, OBJECT_LIST_KEYS, NESTED_ITEM_KEYS, ENVELOPE_KEY } from "../config/attemptCopy.js";
import { handleForcedSSEToJson } from "./chatCore/sseToJsonHandler.js";
import { handleNonStreamingResponse } from "./chatCore/nonStreamingHandler.js";
import { jsonReplyToSse } from "./chatCore/jsonToSse.js";
import { SSE_HEADERS_CORS } from "../utils/sseConstants.js";
import { handleStreamingResponse, buildOnStreamComplete } from "./chatCore/streamingHandler.js";
import { detectClientTool, isNativePassthrough } from "../utils/clientDetector.js";
import { dedupeTools } from "../utils/toolDeduper.js";
import { getCapabilitiesForModel } from "../providers/capabilities.js";
import { stripUnsupportedModalities } from "../translator/concerns/modality.js";
import { prefetchRemoteImages } from "../translator/concerns/prefetch.js";
import { defaultClaudeToolType } from "../translator/concerns/toolCall.js";
import { takeToolMetadata } from "../translator/concerns/toolNamespace.js";
import { mapToolDefinitions } from "../translator/concerns/toolChanges.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { streamOverride } from "./chatCore/endpointOverrides.js";
import { sameJson } from "@/shared/utils/jsonMeasure.js";

/**
 * Core chat handler - shared between SSE and Worker
 * @param {object} options.body - Request body
 * @param {object} options.modelInfo - { provider, model }
 * @param {object} options.credentials - Provider credentials
 * @param {string} options.sourceFormatOverride - Override detected source format (e.g. "openai-responses")
 */
/**
 * Remove translator-internal continuity fields from the outbound upstream
 * body. The Responses→Chat request translator stashes reasoning
 * `encrypted_content` on assistant messages so a later openai→responses
 * round-trip can restore the store=false continuity blob; that stash must
 * never reach an upstream provider. Chat-native proxies reject the unknown
 * assistant-message field and answer every turn with a literal "400" body
 * (observed with multi-turn Codex sessions via OpenAI-compatible nodes).
 */
export function stripContinuityFields(body) {
  if (!body || !Array.isArray(body.messages)) return body;
  for (const msg of body.messages) {
    if (msg && typeof msg === "object") {
      delete msg.encrypted_content;
      delete msg.reasoning_encrypted_content;
    }
  }
  return body;
}

// "Streaming: Always" only works when handleForcedSSEToJson can fold the reply back:
// an OpenAI (Chat or Responses) upstream for an OpenAI-format client. A Claude SSE
// reply would come back empty, so other pairs keep the client's own choice.
export function alwaysStreams(provider, model, sourceFormat, credentials) {
  if (streamOverride(provider, credentials) !== "always") return false;
  const alias = PROVIDER_ID_TO_ALIAS[provider] || provider;
  const upstream = resolveCompatibleRoute(provider, stripThinkingSuffix(getModelUpstreamId(alias, model)), credentials)?.format
    || getTargetFormat(provider, credentials);
  const openai = (f) => f === FORMATS.OPENAI || f === FORMATS.OPENAI_RESPONSES;
  return openai(upstream) && openai(sourceFormat);
}

/**
 * Will the CLIENT be answered with an SSE stream?
 *
 * Deliberately distinct from the `stream` flag chatCore sends upstream: a
 * `forceStream` provider is always fetched over SSE, then converted back to JSON
 * by handleForcedSSEToJson when the client didn't ask for a stream. Exported
 * because the rate-limit hold can only write a status banner into a response
 * that really is a stream — handing SSE to a JSON client breaks it.
 */
export function clientReceivesStream({ body, provider, model, sourceFormat, clientRawRequest, credentials = /** @type {any} */ (null) }) {
  // What the CLIENT gets, which is not always what we ask upstream for. A
  // forceStream provider is fetched over SSE even for a JSON client, because
  // handleForcedSSEToJson converts the stream back down — so `forceStream` says
  // nothing about the response shape the client sees, and must not short-circuit.
  const clientRequestedStreaming = body.stream === true
    || sourceFormat === FORMATS.ANTIGRAVITY
    || sourceFormat === FORMATS.GEMINI
    || sourceFormat === FORMATS.GEMINI_CLI;
  if (PROVIDERS[provider]?.forceStream === true && !clientRequestedStreaming) return false;
  // "Streaming: Always" on a custom endpoint acts like forceStream. "Never" still
  // replays the JSON as SSE for a streaming client, so it changes nothing here.
  if (alwaysStreams(provider, model, sourceFormat, credentials) && !clientRequestedStreaming) return false;

  const alias = PROVIDER_ID_TO_ALIAS[provider] || provider;
  const modelType = getModelType(alias, model);
  const isImageGenModel = modelType === "imageGen" || /image|imagen|image-generation/i.test(model);
  if (isImageGenModel && (provider === "antigravity" || provider === "gemini-cli")) return false;

  const detectedTool = detectClientTool(clientRawRequest?.headers || {}, body);
  if (detectedTool === "deepseek-tui" && body.stream !== true) return false;

  return !clientDemandsJson(body, clientRawRequest?.headers);
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const shallowCopy = (value) => (isObject(value) ? { ...value } : value);

// A history item (message, input item, Gemini content) with its own lists of
// shallow-copied blocks.
function copyItem(item) {
  if (!isObject(item)) return item;
  const copy = { ...item };
  for (const key of ITEM_LIST_KEYS) {
    if (Array.isArray(item[key])) copy[key] = item[key].map(shallowCopy);
  }
  return copy;
}

function copyLevels(obj) {
  const copy = { ...obj };
  for (const key of HISTORY_KEYS) {
    if (Array.isArray(obj[key])) copy[key] = obj[key].map(copyItem);
  }
  for (const key of OBJECT_LIST_KEYS) {
    if (Array.isArray(obj[key])) copy[key] = obj[key].map(shallowCopy);
  }
  for (const key of NESTED_ITEM_KEYS) {
    if (isObject(obj[key])) copy[key] = copyItem(obj[key]);
  }
  return copy;
}

// The attempt's own copy of the body, down to the depth translators and
// executors edit (config/attemptCopy.js), so nothing it changes reaches the
// next attempt or the client's request.
function copyBodyForAttempt(body) {
  if (!isObject(body)) return body;
  const copy = copyLevels(body);
  if (isObject(body[ENVELOPE_KEY])) copy[ENVELOPE_KEY] = copyLevels(body[ENVELOPE_KEY]);
  for (const key of THINKING_OBJECT_KEYS) {
    if (body[key] === null || typeof body[key] !== "object") continue;
    try { copy[key] = structuredClone(body[key]); } catch { copy[key] = { ...body[key] }; }
  }
  return copy;
}

// The client's history list, which every attempt at one request shares.
function clientHistoryOf(body) {
  const lists = [...HISTORY_KEYS.map((key) => body?.[key]), body?.[ENVELOPE_KEY]?.contents];
  return lists.find(Array.isArray) || null;
}

/**
 * One attempt at one account. `clientSignal` aborts when the client hangs up.
 * While the attempt waits on the upstream, that aborts the upstream call (the
 * executor's catch then settles the attempt). Once a stream is returned it is a
 * disconnect instead, which ends the stream's bookkeeping the way a cancelled
 * body does. The listener comes off the signal (shared by every attempt of the
 * request) once the attempt is over: on a failure or a reply that isn't a
 * stream. A stream keeps it until it ends.
 */
export async function handleChatCore(args) {
  const hangUp = { onAbort: null, streaming: false };
  let result = null;
  try {
    result = await runChatCore(args, hangUp);
    return result;
  } finally {
    hangUp.streaming = !!result?.success && (result.response?.headers?.get?.("content-type") || "").includes("text/event-stream");
    if (hangUp.onAbort && !hangUp.streaming) args.clientSignal?.removeEventListener?.("abort", hangUp.onAbort);
  }
}

async function runChatCore({ body, modelInfo, credentials, log, onCredentialsRefreshed, onBetasRejected, onHeadersBudget, onRequestSuccess, onDisconnect, clientRawRequest, connectionId, userAgent, apiKey, ccFilterNaming, sourceFormatOverride, providerThinking, clientSignal = null, drainOnDisconnect = false, attemptCache = null }, hangUp) {
  const { provider, model } = modelInfo;
  // What the previous attempt sent (executors/base.js prepareSend) and its
  // client request, so this one reuses them when they come out the same: the
  // account loop's, shared by one request's attempts until a reply starts
  // (see below), or this call's own (the send after a token refresh).
  const bodyCache = attemptCache || {};
  const requestStartTime = Date.now();
  // Stable per-session color so all lines of one CLI conversation share a tag
  const sessionSeed = (() => {
    try {
      return resolveSessionId({ headers: clientRawRequest?.headers, body, connectionId, scope: provider });
    } catch {
      return connectionId || "";
    }
  })();
  const reqTag = log?.tagForSession ? log.tagForSession(sessionSeed) : (log?.nextTag ? log.nextTag() : "");

  const sourceFormat = sourceFormatOverride || detectFormat(body);
  // Images fetched for one attempt are kept for the rest of the client request.
  // The client's signal is shared by every attempt, fusion panel and judge;
  // without one, the client's history list (taken before anything replaces it).
  const imageCacheKey = clientSignal || clientHistoryOf(body);

  // A previous turn may have been paused by a rate-limit hold, which wrote a
  // status banner into the assistant message the client just sent back. Add a
  // system turn telling the model to disregard it. No-op when no banner present.
  body = injectLimitHoldNotice(body, sourceFormat);

  // Check for bypass patterns (warmup, skip, cc naming)
  const bypassResponse = handleBypassRequest(body, model, userAgent, ccFilterNaming, sourceFormat);
  if (bypassResponse) return bypassResponse;

  const alias = PROVIDER_ID_TO_ALIAS[provider] || provider;
  const modelTargetFormat = getModelTargetFormat(alias, model);
  // Multi-endpoint providers: pick transport matching sourceFormat → zero translation.
  // Per-model guard: only use the transport when the model declares support for that
  // sourceFormat — opencode-go models differ in endpoint support (kimi/glm only do
  // /chat/completions), so without this guard a claude-format request would wrongly
  // route kimi to /messages.
  const modelSupportedFormats = getModelSupportedFormats(alias, model);
  const runtimeTransport = resolveTransport(provider, sourceFormat);
  // Per-model guard: when a model declares supportedFormats, only use the
  // sourceFormat-matched transport if that format is declared (opencode-go models
  // differ — kimi/glm only do /chat/completions). Undeclared models keep the
  // upstream default (use the transport), preserving behavior for glm/deepseek/...
  const sourceTransport = (!modelSupportedFormats || modelSupportedFormats.includes(sourceFormat)) ? runtimeTransport : null;
  // Two-path custom endpoints route each model to the API that serves it best.
  // modelRoutes holds plain ids, so drop the dashboard's "(level)" suffix first.
  const useTransport = resolveCompatibleRoute(provider, stripThinkingSuffix(getModelUpstreamId(alias, model)), credentials)
    || sourceTransport || (modelTargetFormat ? resolveTransport(provider, modelTargetFormat) : null);
  // A source-format-matched endpoint keeps the request lossless. Prefer it
  // over a model-level targetFormat, which is only the fallback for clients
  // whose wire format has no supported transport (for example MiniMax-M3:
  // OpenAI clients should stay on /chat/completions; other clients can fall
  // back to its declared Claude target).
  const targetFormat = useTransport?.format || modelTargetFormat || getTargetFormat(provider, credentials);
  if (useTransport && credentials) credentials.runtimeTransport = useTransport;
  const stripList = getModelStrip(alias, model);
  const upstreamModel = getModelUpstreamId(alias, model);

  // Request details record the client's request: take it before the router
  // adds its own thinking settings below or translation edits the body.
  const clientRequestConfig = extractRequestConfig(body, undefined);
  // The account and combo loops reuse the client's body for the next attempt, and
  // translators and executors edit its nested objects in place.
  body = copyBodyForAttempt(body);

  // Inject provider-level thinking config override (only if client hasn't set)
  // on/off → extended type (body.thinking), none/low/medium/high → effort type (body.reasoning_effort)
  if (providerThinking?.mode && providerThinking.mode !== "auto") {
    const mode = providerThinking.mode;
    if (mode === "on" && !body.thinking) {
      console.log("Injecting provider-level thinking config override: on");
      body = { ...body, thinking: { type: "enabled", budget_tokens: 10000 } };
    } else if (mode === "off" && !body.thinking) {
      body = { ...body, thinking: { type: "disabled" } };
    } else if (!body.reasoning_effort) {
      body = { ...body, reasoning_effort: mode };
    }
  }

  const clientRequestedStreaming = body.stream === true || sourceFormat === FORMATS.ANTIGRAVITY || sourceFormat === FORMATS.GEMINI || sourceFormat === FORMATS.GEMINI_CLI;
  // A custom endpoint's "Streaming: Always / Never" setting.
  const streamMode = streamOverride(provider, credentials);
  const providerRequiresStreaming = PROVIDERS[provider]?.forceStream === true || (streamMode === "always" && alwaysStreams(provider, model, sourceFormat, credentials));
  // Upstream request shape — a forceStream provider is always fetched as SSE,
  // even when the client wants JSON (handleForcedSSEToJson converts it back).
  let stream = providerRequiresStreaming ? true : (body.stream !== false);

  // Image generation models require non-streaming (Google v1internal:generateContent)
  const modelType = getModelType(alias, model);
  const isImageGenModel = modelType === "imageGen" || /image|imagen|image-generation/i.test(model);
  if (isImageGenModel && (provider === "antigravity" || provider === "gemini-cli")) {
    stream = false;
  }

  // DeepSeek-TUI: interactive TUI panel sends stream:true and needs SSE.
  // Non-interactive mode (-p flag) sends without stream and can't parse SSE.
  // Only force non-streaming when client didn't explicitly request it.
  const detectedTool = detectClientTool(clientRawRequest?.headers || {}, body);
  if (detectedTool === "deepseek-tui" && body.stream !== true) stream = false;

  // A client that sends Accept: application/json (AI SDK) wants JSON.
  if (clientDemandsJson(body, clientRawRequest?.headers) && !providerRequiresStreaming) stream = false;
  if (streamMode === "never") stream = false;
  // An attempt whose client request serializes as the previous attempt's
  // reuses that object, so request details cap it once per request.
  let clientRequest = { ...clientRequestConfig, stream };
  if (sameJson(bodyCache.clientRequest, clientRequest)) clientRequest = bodyCache.clientRequest;
  else bodyCache.clientRequest = clientRequest;

  const reqLogger = await createRequestLogger(sourceFormat, targetFormat, model);
  if (clientRawRequest) reqLogger.logClientRawRequest(clientRawRequest.endpoint, clientRawRequest.body, clientRawRequest.headers);
  reqLogger.logRawRequest(body);
  log?.debug?.("FORMAT", `${sourceFormat} → ${targetFormat} | stream=${stream}`);

  // Native passthrough: CLI tool and provider are the same ecosystem
  // Skip all translation/normalization — only model and Bearer are swapped
  const clientTool = detectClientTool(clientRawRequest?.headers || {}, body);
  // A two-path node routes some models to its other API; those need translating.
  const passthrough = isNativePassthrough(clientTool, provider) && (!useTransport?.compatibleRoute || targetFormat === sourceFormat);

  // Expose raw client headers to translators/executors for session-id resolution
  if (credentials) {
    credentials.rawHeaders = clientRawRequest?.headers || {};
    // Which client key this request came in on, so per-session state stays with it.
    credentials.clientScope = apiKey ? createHash("sha256").update(apiKey).digest("hex").slice(0, 16) : "local";
  }

  // Auto-strip media blocks the model can't read (vision/audio/pdf) before translation.
  if (!passthrough) {
    const caps = getCapabilitiesForModel(provider, model);
    if (stripUnsupportedModalities(body, sourceFormat, caps)) {
      log?.debug?.("MODALITY", `stripped unsupported media for ${provider}/${model}`);
    }
    // Convert remote image URLs to base64 for targets that can't fetch URLs.
    try {
      const n = await prefetchRemoteImages(body, sourceFormat, targetFormat, { signal: undefined, cacheKey: imageCacheKey });
      if (n > 0) log?.debug?.("MODALITY", `prefetched ${n} remote image(s) for ${targetFormat}`);
    } catch (e) { log?.warn?.("MODALITY", `image prefetch failed: ${e.message}`); }
  }

  let translatedBody;
  let toolNameMap;
  let customToolNames;
  let toolNamespaces;
  if (passthrough) {
    log?.debug?.("PASSTHROUGH", `${clientTool} → ${provider} | native lossless`);
    translatedBody = { ...body, model: stripThinkingSuffix(upstreamModel) };
    if (provider === "codex") {
      const suffixThinking = {};
      applyThinking(sourceFormat, upstreamModel, suffixThinking, provider);
      const suffixEffort = suffixThinking.reasoning?.effort || suffixThinking.reasoning_effort;
      if (suffixEffort) {
        const reasoning = translatedBody.reasoning;
        translatedBody.reasoning = {
          ...(reasoning && typeof reasoning === "object" && !Array.isArray(reasoning) ? reasoning : {}),
          effort: suffixEffort,
        };
        delete translatedBody.reasoning_effort;
      }
    }
    // Normalize newer Cowork/CC beta shapes (adaptive thinking, mid-conversation system) the API rejects
    if (clientTool === "claude") normalizeClaudePassthrough(translatedBody, translatedBody.model, provider);
  } else {
    translatedBody = translateRequest(sourceFormat, targetFormat, upstreamModel, body, stream, credentials, provider, reqLogger, stripList, connectionId, clientTool);
    if (!translatedBody) {
      return createErrorResult(HTTP_STATUS.BAD_REQUEST, `Failed to translate request for ${sourceFormat} → ${targetFormat}`);
    }
    toolNameMap = translatedBody._toolNameMap;
    delete translatedBody._toolNameMap;
    ({ customToolNames, toolNamespaces } = takeToolMetadata(translatedBody));
    translatedBody.model = stripThinkingSuffix(upstreamModel);
    stripContinuityFields(translatedBody);
  }

  // Dedupe duplicate built-in tools when equivalent MCP tools are present (Claude clients only).
  if (clientTool === "claude" && Array.isArray(translatedBody.tools)) {
    const { tools: deduped, stripped } = dedupeTools(translatedBody.tools);
    if (stripped.length > 0) {
      translatedBody.tools = deduped;
      log?.debug?.("TOOLDEDUP", `stripped ${stripped.length}: ${stripped.slice(0, 3).join(", ")}${stripped.length > 3 ? "..." : ""}`);
    }
  }

  // Shape of the body sent upstream: source shape on passthrough, target shape otherwise
  const finalFormat = passthrough ? sourceFormat : targetFormat;

  // Request line: one correlated summary (fmt + thinking + counts + account)
  if (log?.line) {
    const clientModel = clientRawRequest?.body?.model || `${provider}/${model}`;
    const msgN = translatedBody.messages?.length || translatedBody.input?.length || translatedBody.contents?.length || body.messages?.length || body.input?.length || 0;
    const toolN = translatedBody.tools?.length || body.tools?.length || 0;
    const fmtStr = passthrough ? `FMT: ${sourceFormat} (passthrough)` : `FMT: ${sourceFormat}→${targetFormat}`;
    const showThinking = provider !== "grok-cli" || supportsGrokCliReasoningEffort(model);
    const think = showThinking ? log.fmtThink?.(extractThinking(translatedBody)) : null;
    const acc = credentials?.connectionName || credentials?.connectionId?.slice(0, 8) || "-";
    const parts = [
      `POST ${clientModel} → ${provider}/${model}`,
      fmtStr,
      stream ? "STREAM" : "JSON",
      `${msgN} MSG`,
    ];
    if (toolN) parts.push(`${toolN} TOOL`);
    if (think) parts.push(`THINK:${think}`);
    parts.push(`ACC:${acc}`);
    log.line(reqTag, "▶", parts.join(" · "));
  }

  // TTS models don't support tool messages/function calling
  if (getModelType(alias, model) === "tts" && translatedBody.messages) {
    translatedBody.messages = translatedBody.messages.filter(msg => msg.role !== "tool");
    delete translatedBody.tools;
  }

  // Claude tool schema requires `type` to be explicitly set.
  if (finalFormat === FORMATS.CLAUDE && Array.isArray(translatedBody.tools)) {
    translatedBody.tools = defaultClaudeToolType(translatedBody.tools);
  }
  // Tools added by value mid-conversation too, so they're sent the same way.
  if (finalFormat === FORMATS.CLAUDE) translatedBody = mapToolDefinitions(translatedBody, (def) => defaultClaudeToolType([def])[0]);

  // Pin cache breakpoints to the final body; a stale anchor costs a full prefix rewrite.
  if (passthrough && clientTool === "claude") anchorClaudeCache(translatedBody);

  const executor = getExecutor(provider);
  trackPendingRequest(model, provider, connectionId, true);
  appendRequestLog({ model, provider, connectionId, status: "PENDING" }).catch(() => { });

  const msgCount = translatedBody.messages?.length || translatedBody.input?.length || translatedBody.contents?.length || translatedBody.request?.contents?.length || 0;
  log?.debug?.("REQUEST", `${provider.toUpperCase()} | ${model} | ${msgCount} msgs`);

  // The pending count goes down exactly once, however the request ends (a
  // hang-up followed by the stream's own end must not count twice).
  let pendingOpen = true;
  const endPending = () => {
    if (!pendingOpen) return;
    pendingOpen = false;
    trackPendingRequest(model, provider, connectionId, false);
  };
  const streamController = createStreamController({
    onDisconnect: (reason) => {
      endPending();
      if (onDisconnect) onDisconnect(reason);
    },
    onError: endPending,
    log, provider, model, reqTag,
    // A key with a budget is charged the provider's real usage even when its
    // client hangs up mid-stream: the upstream is read to its final usage.
    drainOnDisconnect, drainMaxMs: STREAM_DRAIN_MAX_MS,
  });
  // A hang-up is a disconnect: the pending count goes down, nothing is a failure.
  const endAsHangUp = () => {
    endPending();
    streamController.handleComplete();
    return clientAbortResult();
  };
  // When the upstream attempt in flight was sent. 0: none is (not sent yet, the
  // client had already left, or the last attempt came back with an error and
  // the next isn't out). Set here before each execute(); executors that retry
  // or prepare inside execute() keep it exact through onUpstreamAttempt.
  // Executors that never report keep this start.
  let attemptStart = 0;
  // Only while execute() runs: once it has returned, the attempt it reported
  // is the one being read, whatever an executor does inside the body.
  let executing = false;
  const onUpstreamAttempt = (ts) => { if (executing) attemptStart = ts; };
  const runAttempt = async (args) => {
    attemptStart = clientSignal?.aborted ? 0 : Date.now();
    executing = true;
    try {
      return await executor.execute({ ...args, onUpstreamAttempt });
    } finally {
      executing = false;
    }
  };
  // A hang-up while an attempt is in flight still costs the owner, so it is
  // charged like a cut-short stream: input, plus the time floor from floorFrom.
  // By default a JSON upstream's floor starts with the attempt (it generates
  // before it answers); a stream's starts at its first byte, which never came.
  const chargeHangUp = (floorFrom = stream ? null : attemptStart) => {
    if (!attemptStart) return;
    const tokens = hangUpUsage({ body, sentBody: finalBody || translatedBody, floorFrom });
    saveUsageStats({ provider, model, tokens, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, silent: true });
  };
  // The client hung up: drop the upstream call.
  if (clientSignal?.aborted) streamController.abort();
  else if (clientSignal) {
    hangUp.onAbort = () => (hangUp.streaming ? streamController.handleDisconnect("client_closed") : streamController.abort());
    clientSignal.addEventListener("abort", hangUp.onAbort, { once: true });
  }

  const proxyOptions = {
    connectionProxyEnabled: credentials?.providerSpecificData?.connectionProxyEnabled === true,
    connectionProxyUrl: credentials?.providerSpecificData?.connectionProxyUrl || "",
    connectionNoProxy: credentials?.providerSpecificData?.connectionNoProxy || "",
    vercelRelayUrl: credentials?.providerSpecificData?.vercelRelayUrl || "",
    strictProxy: credentials?.providerSpecificData?.strictProxy === true,
    direct: credentials?.providerSpecificData?.direct === true,
    blockedReason: credentials?.providerSpecificData?.blockedReason || "",
  };

  if (proxyOptions.vercelRelayUrl) {
    const connectionName = credentials?.connectionName || credentials?.connectionId || "unknown";
    const poolId = credentials?.providerSpecificData?.connectionProxyPoolId || "none";
    log?.info?.("PROXY", `${provider.toUpperCase()} | ${model} | conn=${connectionName} | pool=${poolId} | vercel-relay=${proxyOptions.vercelRelayUrl}`);
  } else if (proxyOptions.connectionProxyEnabled && proxyOptions.connectionProxyUrl) {
    let maskedProxyUrl = proxyOptions.connectionProxyUrl;
    try {
      const parsed = new URL(proxyOptions.connectionProxyUrl);
      const host = parsed.hostname || "";
      const port = parsed.port ? `:${parsed.port}` : "";
      const protocol = parsed.protocol || "http:";
      maskedProxyUrl = `${protocol}//${host}${port}`;
    } catch {
      // Keep raw if URL parsing fails
    }

    const poolId = credentials?.providerSpecificData?.connectionProxyPoolId || "none";
    const connectionName = credentials?.connectionName || credentials?.connectionId || "unknown";
    log?.info?.("PROXY", `${provider.toUpperCase()} | ${model} | conn=${connectionName} | pool=${poolId} | url=${maskedProxyUrl}`);
  }

  if (proxyOptions.connectionProxyEnabled && proxyOptions.connectionNoProxy) {
    const connectionName = credentials?.connectionName || credentials?.connectionId || "unknown";
    log?.debug?.("PROXY", `${provider.toUpperCase()} | ${model} | conn=${connectionName} | no_proxy=${proxyOptions.connectionNoProxy}`);
  }

  // Execute request
  let providerResponse, providerUrl, providerHeaders, finalBody;
  // Most executors return their registry format. Cursor AgentService is an
  // exception: it is decoded by the executor into OpenAI-compatible output.
  let providerResponseFormat = targetFormat;
  // When executor.execute returned: the upstream's final response headers, after
  // any retries and backoff sleeps inside the executor (a 503 retried 3 times with
  // 2s sleeps records over 6s). Upstream-error rows report it as ttft.
  let upstreamRespondedAt = 0;
  // A 401/403 sent the request through a token refresh and a retry.
  let authRetried = false;
  try {
    // Refuse before any executor runs: not every executor sends through proxyAwareFetch.
    if (proxyOptions.blockedReason) throw new Error(`[ProxyFetch] Request blocked: ${proxyOptions.blockedReason}`);
    const result = await runAttempt({ model, body: translatedBody, stream, credentials, signal: streamController.signal, log, proxyOptions, onBetasRejected, onHeadersBudget, imageCacheKey, bodyCache });
    upstreamRespondedAt = Date.now();
    providerResponse = result.response;
    providerUrl = result.url;
    providerHeaders = result.headers;
    finalBody = result.transformedBody;
    providerResponseFormat = result.responseFormat || targetFormat;
    reqLogger.logTargetRequest(providerUrl, providerHeaders, finalBody);
  } catch (error) {
    if (isClientAbort(error, clientSignal)) {
      chargeHangUp();
      return endAsHangUp();
    }
    trackPendingRequest(model, provider, connectionId, false, true);
    const failStatus = error?.name === "AbortError" ? HTTP_STATUS.CLIENT_CLOSED_REQUEST
      : isUpstreamHeadersTimeout(error) ? error.status : HTTP_STATUS.BAD_GATEWAY;
    appendRequestLog({ model, provider, connectionId, status: `FAILED ${failStatus}` }).catch(() => { });
    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId,
      latency: { ttft: 0, total: Date.now() - requestStartTime },
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      request: clientRequest,
      // Untagged error: the executor's own last edit, with the headers unknown.
      providerRequest: error?.transformedBody || executor.finalizeBody?.(translatedBody, null, credentials) || translatedBody || null,
      response: { error: error?.message || String(error), status: failStatus, thinking: null },
      status: "error",
      errorClass: classifyThrownError(error)
    })).catch(() => { });

    if (error?.name === "AbortError") {
      streamController.handleError(error);
      return clientAbortResult();
    }
    const errMsg = formatProviderError(error ?? {}, provider, model, failStatus);
    if (log?.errorLine) {
      log.errorLine(reqTag, "✗", `ERROR ${failStatus} · ${provider}/${model} · ${Date.now() - requestStartTime}ms\n    ${errMsg}${error?.stack ? `\n    ${error.stack}` : ""}`);
    }
    const failed = createErrorResult(failStatus, errMsg);
    return isUpstreamHeadersTimeout(error) ? { ...failed, headersTimeout: { stream: error.stream === true } } : failed;
  }

  // Handle 401/403 - try token refresh (skip for noAuth providers)
  if (!executor.noAuth && (providerResponse.status === HTTP_STATUS.UNAUTHORIZED || providerResponse.status === HTTP_STATUS.FORBIDDEN)) {
    // That attempt is over; nothing is in flight until the retry goes out.
    attemptStart = 0;
    authRetried = true;
    try {
      // Mutate credentials after each successful refresh: rotating refresh_token
      // providers (xAI/grok-cli) issue a new RT on every refresh; without this,
      // refreshWithRetry's 2nd/3rd attempt reuses the already-consumed RT →
      // invalid_grant → auth_failed retryable=false.
      const newCredentials = await refreshWithRetry(async () => {
        const result = await executor.refreshCredentials(credentials, log, proxyOptions);
        if (result?.refreshToken && result.refreshToken !== credentials.refreshToken) {
          if (result.accessToken) credentials.accessToken = result.accessToken;
          credentials.refreshToken = result.refreshToken;
        }
        return result;
      }, 3, log);
      if (newCredentials?.accessToken || newCredentials?.copilotToken) {
        if (log?.line) log.line(reqTag, "🔑", `TOKEN REFRESHED · ${provider}/${model}`);
        applyRefreshedCredentials(credentials, newCredentials);
        if (onCredentialsRefreshed) {
          try { await onCredentialsRefreshed(newCredentials); } catch (e) { log?.warn?.("TOKEN", `onCredentialsRefreshed failed: ${e.message}`); }
        }
        try {
          const retryResult = await runAttempt({ model, body: translatedBody, stream, credentials, signal: streamController.signal, log, proxyOptions, onHeadersBudget, imageCacheKey, bodyCache });
          if (retryResult.response.ok) {
            upstreamRespondedAt = Date.now();
            providerResponse = retryResult.response;
            providerUrl = retryResult.url;
            providerResponseFormat = retryResult.responseFormat || targetFormat;
          } else if (!clientSignal?.aborted) {
            attemptStart = 0;
          }
        } catch (error) {
          // A hang-up leaves the retry in flight, to be charged below.
          if (!isClientAbort(error, clientSignal)) attemptStart = 0;
          log?.warn?.("TOKEN", `${provider.toUpperCase()} | retry after refresh failed`);
        }
      } else {
        log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh failed`);
      }
    } catch (e) {
      log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh threw: ${e.message}`);
    }
  }
  // A reply is under way and nothing is sent again, so the stream doesn't keep
  // the body's bytes alive. Emptied, not dropped: executor closures still hold
  // the cache. A failed attempt leaves them for the account loop's next one
  // (which drops them before waiting for a warm key).
  if (providerResponse.ok) bodyCache.last = bodyCache.clientRequest = null;

  // Hung up with an error in hand: a disconnect, not a failure. Either during
  // the token refresh (a retry already sent with the new token is charged), or
  // while an executor that buffers through generation (Cursor, Trae) was
  // reading, which it reports as an error response: charged from the attempt,
  // streaming or not.
  if (!providerResponse.ok && clientSignal?.aborted) {
    providerResponse.body?.cancel().catch(() => { });
    if (authRetried) chargeHangUp();
    else chargeHangUp(attemptStart);
    return endAsHangUp();
  }

  // Provider returned error
  if (!providerResponse.ok) {
    trackPendingRequest(model, provider, connectionId, false, true);
    const { statusCode, message, resetsAtMs } = await parseUpstreamError(providerResponse, executor);
    appendRequestLog({ model, provider, connectionId, status: `FAILED ${statusCode}` }).catch(() => { });
    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId,
      latency: { ttft: upstreamRespondedAt - requestStartTime, total: Date.now() - requestStartTime },
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      request: clientRequest,
      providerRequest: finalBody || translatedBody || null,
      response: { error: message, status: statusCode, thinking: null },
      status: "error",
      errorClass: classifyError(statusCode, message)
    })).catch(() => { });

    const errMsg = formatProviderError(new Error(message), provider, model, statusCode);
    if (log?.errorLine) {
      const urlStr = providerUrl ? `\n    URL: ${providerUrl}` : "";
      log.errorLine(reqTag, "✗", `ERROR ${statusCode} · ${provider}/${model} · ${Date.now() - requestStartTime}ms${urlStr}\n    ${errMsg}`);
    }
    reqLogger.logError(new Error(message), finalBody || translatedBody);
    return createErrorResult(statusCode, errMsg, resetsAtMs);
  }

  // The body handlers answer 499 only when the client hung up mid-read. An
  // executor whose body wrapper turned the hang-up into a short or broken
  // reply shows up as a failure with the client gone; that is charged too.
  // Neither is charged once the handler has recorded the reply's usage (it
  // logs the tokens right before it saves them), so a handler that fails
  // after that can't charge the request twice. An SSE body is charged from
  // its first byte (executors that read ahead before returning, Codex and
  // Kiro, record when it really started), a JSON one from when its attempt
  // was sent.
  let usageRecorded = false;
  const charged = (result, sse) => {
    const hungUp = result?.status === HTTP_STATUS.CLIENT_CLOSED_REQUEST || (result && !result.success && clientSignal?.aborted);
    if (hungUp && !usageRecorded) chargeHangUp(sse ? providerResponse.upstreamStartedAt || upstreamRespondedAt : attemptStart);
    return result;
  };
  const sharedCtx = { provider, model, body, stream, clientRequest, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, reqTag, log, clientSignal };
  const appendLog = (extra) => {
    if (extra?.tokens) usageRecorded = true;
    return appendRequestLog({ model, provider, connectionId, ...extra }).catch(() => { });
  };
  const trackDone = endPending;

  // Provider forced streaming but client wants JSON
  if (!clientRequestedStreaming && providerRequiresStreaming) {
    const result = charged(await handleForcedSSEToJson({ ...sharedCtx, providerResponse, sourceFormat, targetFormat: providerResponseFormat, customToolNames, toolNamespaces, trackDone, appendLog }), true);
    if (result) { streamController.handleComplete(); return result; }
  }

  // True non-streaming response. Also when we wanted a stream but the upstream
  // answered with plain JSON: a client that left `stream` out reaches us as a
  // stream, but an upstream that defaults to JSON (Anthropic-style APIs, OpenAI
  // when `stream` is absent) never sees that flag. Piping that JSON through the
  // SSE transform would hand back the JSON plus a stray "data: [DONE]".
  const upstreamType = (providerResponse.headers?.get?.("content-type") || "").toLowerCase();
  const upstreamSentJson = upstreamType.includes("application/json") && !upstreamType.includes("text/event-stream");
  if (!stream || upstreamSentJson) {
    const result = charged(await handleNonStreamingResponse({ ...sharedCtx, providerResponse, sourceFormat, targetFormat: providerResponseFormat, reqLogger, toolNameMap, customToolNames, toolNamespaces, trackDone, appendLog }), upstreamType.includes("text/event-stream"));
    streamController.handleComplete();
    // The client asked to stream: replay the finished reply as its own SSE.
    if (clientRequestedStreaming && result?.success) {
      const replay = jsonReplyToSse(await result.response.clone().json().catch(() => null), sourceFormat);
      if (replay) return { success: true, response: new Response(replay, { headers: SSE_HEADERS_CORS }) };
    }
    return result;
  }

  // Streaming response
  const { onStreamComplete, streamDetail } = buildOnStreamComplete({ ...sharedCtx });
  const streaming = handleStreamingResponse({ ...sharedCtx, providerResponse, sourceFormat, targetFormat: providerResponseFormat, userAgent, reqLogger, toolNameMap, customToolNames, toolNamespaces, streamController, onStreamComplete, streamDetail, endPending });
  // The reply is under way and nothing is sent upstream again. The stream's
  // callbacks (endPending, the hang-up listener) keep this call's closures,
  // and so these, alive until it ends: let go of the prompt.
  body = translatedBody = finalBody = clientRawRequest = null;
  return streaming;
}

export function isTokenExpiringSoon(expiresAt, bufferMs = 5 * 60 * 1000) {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() - Date.now() < bufferMs;
}
