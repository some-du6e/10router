import { FORMATS } from "./formats.js";
import { ensureToolCallIds, fixMissingToolResponses } from "./concerns/toolCall.js";
import { prepareClaudeRequest } from "./formats/claude.js";
import { cloakClaudeTools, decloakStreamChunk } from "../utils/claudeCloaking.js";
import { filterToOpenAIFormat } from "./formats/openai.js";
import { normalizeThinkingConfig } from "../services/provider.js";
import { applyThinking, captureThinking } from "./concerns/thinkingUnified.js";
import { captureSessionId } from "../utils/sessionManager.js";
import { AntigravityExecutor } from "../executors/antigravity.js";
import { PROVIDERS } from "../providers/index.js";
import { CLAUDE_SYSTEM_PROMPT } from "../config/appConstants.js";

// Request/response bodies are arbitrary upstream JSON; translators reshape them field by field.
type Body = Record<string, any>;
type RequestTranslator = (model: string, body: Body, stream: boolean, credentials: Credentials | null) => Body;
type ResponseTranslator = (chunk: any, state: any) => any;
type Credentials = {
  accessToken?: string;
  apiKey?: string;
  rawHeaders?: Record<string, string>;
  _clientSessionId?: string | null;
  [key: string]: unknown;
};
type RequestLogger = { logOpenAIRequest?: (body: Body) => void } | null;
type SystemBlock = { type: string; text?: string; [key: string]: unknown };

// Registry for translators. Lazy-init guards against circular-import order:
// translator modules call register() (side-effect) before this module's body runs.
// var (not let): hoisted as undefined so register() can run during circular import (no TDZ).
var requestRegistry: Map<string, RequestTranslator>;
var responseRegistry: Map<string, ResponseTranslator>;

// Register translator
export function register(from: string, to: string, requestFn: RequestTranslator | null, responseFn: ResponseTranslator | null) {
  requestRegistry ??= new Map();
  responseRegistry ??= new Map();
  const key = `${from}:${to}`;
  if (requestFn) {
    requestRegistry.set(key, requestFn);
  }
  if (responseFn) {
    responseRegistry.set(key, responseFn);
  }
}

// No-op: translators self-register via the static imports at the bottom of this file.
function ensureInitialized() {}

// Strip specific content types from messages (explicit opt-in via strip[] in PROVIDER_MODELS)
function stripContentTypes(body: Body, stripList: string[] = []) {
  if (!stripList.length || !body.messages || !Array.isArray(body.messages)) return;
  const imageTypes = new Set(["image_url", "image"]);
  const audioTypes = new Set(["audio_url", "input_audio"]);
  const shouldStrip = (type: string) => {
    if (imageTypes.has(type)) return stripList.includes("image");
    if (audioTypes.has(type)) return stripList.includes("audio");
    return false;
  };
  for (const msg of body.messages) {
    if (!Array.isArray(msg.content)) continue;
    msg.content = msg.content.filter((part: { type: string }) => !shouldStrip(part.type));
    if (msg.content.length === 0) msg.content = "";
  }
}

function providerQuirks(provider: string | null): Record<string, unknown> | undefined {
  return provider ? (PROVIDERS as Record<string, { quirks?: Record<string, unknown> }>)[provider]?.quirks : undefined;
}

// Translate request: source -> openai -> target
// Translator-only fields: set by a source translator, read by the response hop,
// stripped in chatCore before dispatch. They must survive the openai pivot.
const TRANSLATOR_METADATA_KEYS = ["_toolNamespaces", "_customToolNames"];

function withClaudeCodePrompt(system: unknown): SystemBlock[] {
  const blocks: SystemBlock[] = Array.isArray(system) ? system
    : typeof system === "string" && system ? [{ type: "text", text: system }]
    : [];
  if (blocks.some((b) => b?.text?.trim() === CLAUDE_SYSTEM_PROMPT)) return blocks;
  return [{ type: "text", text: CLAUDE_SYSTEM_PROMPT }, ...blocks];
}

export function translateRequest(
  sourceFormat: string,
  targetFormat: string,
  model: string,
  body: Body,
  stream = true,
  credentials: Credentials | null = null,
  provider: string | null = null,
  reqLogger: RequestLogger = null,
  stripList: string[] = [],
  connectionId: string | null = null,
  clientTool: string | null = null,
): Body {
  ensureInitialized();
  let result = body;

  // Strip explicit content types (opt-in via strip[] in PROVIDER_MODELS entry)
  stripContentTypes(result, stripList);

  normalizeThinkingConfig(result);

  // Always ensure tool_calls have id (some providers require it)
  ensureToolCallIds(result);
  
  // Kiro performs stricter source-aware reconciliation after session replay.
  // The generic helper inserts OpenAI `role: tool` messages, which a direct
  // Claude→Kiro translator cannot consume and which cannot repair partial
  // parallel tool results.
  if (targetFormat !== FORMATS.KIRO) {
    fixMissingToolResponses(result);
  }

  // Capture thinking intent from the original (pre-translation) body, before any
  // format conversion strips/renames the fields. Applied after translation.
  const thinkingIntent = captureThinking(result);

  // Capture session id from the original body (envelope still intact, e.g. antigravity request.sessionId)
  const clientSessionId = captureSessionId(result, credentials, connectionId, targetFormat);
  // Expose to downstream translators (gemini-cli/antigravity envelopes) that run after envelope is stripped
  if (credentials) credentials._clientSessionId = clientSessionId;

  // If same format, skip translation steps
  if (sourceFormat !== targetFormat) {
    // Direct route: if a translator is registered for this exact source:target
    // pair, use it instead of pivoting through OpenAI. This is lossless for
    // pairs like claude:kiro (avoids the claude->openai->kiro double-hop).
    const directFn = requestRegistry.get(`${sourceFormat}:${targetFormat}`);
    if (directFn) {
      result = directFn(model, result, stream, credentials);
    } else {
      // Step 1: source -> openai (if source is not openai)
      if (sourceFormat !== FORMATS.OPENAI) {
        const toOpenAI = requestRegistry.get(`${sourceFormat}:${FORMATS.OPENAI}`);
        if (toOpenAI) {
          result = toOpenAI(model, result, stream, credentials);
          // Log OpenAI intermediate format
          reqLogger?.logOpenAIRequest?.(result);
        }
      }

      // Step 2: openai -> target (if target is not openai)
      if (targetFormat !== FORMATS.OPENAI) {
        const fromOpenAI = requestRegistry.get(`${FORMATS.OPENAI}:${targetFormat}`);
        if (fromOpenAI) {
          // Target translators build a fresh body field-by-field, so translator-only
          // metadata set by step 1 (leading `_`, never sent upstream) would be dropped
          // on the pivot. Carry it across so the response hop can still read it.
          const carried = TRANSLATOR_METADATA_KEYS.filter((k) => result[k] !== undefined)
            .map((k) => [k, result[k]]);
          result = fromOpenAI(model, result, stream, credentials);
          for (const [k, v] of carried) {
            if (result && result[k] === undefined) result[k] = v;
          }
        }
      }
    }
  }

  // Normalize thinking to the target provider-native format (config-driven, capability-aware).
  // Kiro's GenerateAssistantResponse request does not accept the generic top-level
  // `thinking` field; its translators map thinking intent to KAS-compatible
  // systemPrompt/additionalModelRequestFields instead.
  const kiroThinkingMappedByTranslator =
    targetFormat === FORMATS.KIRO &&
    (sourceFormat === FORMATS.OPENAI || sourceFormat === FORMATS.CLAUDE);
  if (!kiroThinkingMappedByTranslator) {
    applyThinking(targetFormat, model, result, provider as any, thinkingIntent as any);
  }

  // Always normalize to clean OpenAI format when target is OpenAI
  // This handles hybrid requests (e.g., OpenAI messages + Claude tools)
  if (targetFormat === FORMATS.OPENAI) {
    result = filterToOpenAIFormat(result, {
      preserveCacheControl: !!providerQuirks(provider)?.preserveCacheControl,
    });
  }

  // Final step: prepare request for Claude format endpoints
  if (targetFormat === FORMATS.CLAUDE) {
    // Source translators may create Claude tool_use blocks after the initial
    // normalization pass, so validate their IDs again before repairing history.
    ensureToolCallIds(result);
    // Anthropic OAuth tokens expect the Claude Code identity prompt as its own
    // system block. Plain API keys and other gateways don't get it.
    const apiKey = credentials?.accessToken || credentials?.apiKey || null;
    if (provider === "claude" || apiKey?.includes("sk-ant-oat")) {
      result.system = withClaudeCodePrompt(result.system);
    }
    result = prepareClaudeRequest(result, provider as any, apiKey as any, connectionId as any, credentials?.rawHeaders as any, clientSessionId as any);
  }

  // Claude cloaking: rename client tools with CLAUDE_TOOL_SUFFIX (anti-ban)
  // quirk: only providers flagged cloakToolsOnOAuth, and only with an OAuth token
  if (providerQuirks(provider)?.cloakToolsOnOAuth) {
    const apiKey = credentials?.accessToken || credentials?.apiKey || null;
    if (apiKey?.includes("sk-ant-oat")) {
      const { body: cloakedBody, toolNameMap } = cloakClaudeTools(result);
      result = cloakedBody;
      if (toolNameMap && toolNameMap.size > 0) {
        result._toolNameMap = toolNameMap;
      }
    }
  }

  // Antigravity cloaking disabled
  // if (provider === FORMATS.ANTIGRAVITY && body.userAgent !== FORMATS.ANTIGRAVITY) {
  //   const { cloakedBody, toolNameMap } = AntigravityExecutor.cloakTools(result);
  //   result = cloakedBody;
  //   if (toolNameMap?.size > 0) {
  //     result._toolNameMap = toolNameMap;
  //   }
  // }

  return result;
}

// Translate response chunk: target -> openai -> source
export function translateResponse(targetFormat: string, sourceFormat: string, chunk: any, state: any): any[] & { _openaiIntermediate?: any[] } {
  ensureInitialized();
  // If same format, return as-is — except the tool name may still be cloaked:
  // translateRequest() suffixes client tools for OAuth-cloaked Claude providers
  // even when no format conversion is needed, so streamed tool_use blocks must
  // be decloaked here or the client sees an unknown ("_ide"-suffixed) tool.
  if (sourceFormat === targetFormat) {
    return [decloakStreamChunk(chunk, state?.toolNameMap)];
  }

  let results: any[] & { _openaiIntermediate?: any[] } = [chunk];
  let openaiResults: any[] | null = null; // Store OpenAI intermediate results

  // Direct route: if a response translator is registered for this exact
  // target:source pair, use it instead of pivoting through OpenAI. Mirrors the
  // request-side direct route (e.g. kiro:claude — KiroExecutor already emits
  // OpenAI-shaped chunks, so this converts them straight to Claude SSE).
  const directFn = responseRegistry.get(`${targetFormat}:${sourceFormat}`);
  if (directFn) {
    const converted = directFn(chunk, state);
    return converted ? (Array.isArray(converted) ? converted : [converted]) : [];
  }

  // Step 1: target -> openai (if target is not openai)
  if (targetFormat !== FORMATS.OPENAI) {
    const toOpenAI = responseRegistry.get(`${targetFormat}:${FORMATS.OPENAI}`);
    if (toOpenAI) {
      results = [];
      const converted = toOpenAI(chunk, state);
      if (converted) {
        results = Array.isArray(converted) ? converted : [converted];
        openaiResults = results; // Store OpenAI intermediate
      }
    }
  }

  // Step 2: openai -> source (if source is not openai)
  if (sourceFormat !== FORMATS.OPENAI) {
    const fromOpenAI = responseRegistry.get(`${FORMATS.OPENAI}:${sourceFormat}`);
    if (fromOpenAI) {
      const finalResults: any[] = [];
      for (const r of results) {
        const converted = fromOpenAI(r, state);
        if (converted) {
          finalResults.push(...(Array.isArray(converted) ? converted : [converted]));
        }
      }
      results = finalResults;
    }
  }

  // Attach OpenAI intermediate results for logging
  if (openaiResults && sourceFormat !== FORMATS.OPENAI && targetFormat !== FORMATS.OPENAI) {
    results._openaiIntermediate = openaiResults;
  }

  return results;
}

// Check if translation needed
export function needsTranslation(sourceFormat: string, targetFormat: string) {
  return sourceFormat !== targetFormat;
}

// Initialize state for streaming response based on format
export function initState(sourceFormat: string) {
  // Base state for all formats
  const base = {
    messageId: null,
    model: null,
    textBlockStarted: false,
    thinkingBlockStarted: false,
    inThinkingBlock: false,
    currentBlockIndex: null,
    toolCalls: new Map(),
    finishReason: null,
    finishReasonSent: false,
    usage: null,
    contentBlockIndex: -1
  };

  // Add openai-responses specific fields
  if (sourceFormat === FORMATS.OPENAI_RESPONSES) {
    return {
      ...base,
      seq: 0,
      responseId: `resp_${Date.now()}`,
      created: Math.floor(Date.now() / 1000),
      started: false,
      msgTextBuf: {},
      msgItemAdded: {},
      msgContentAdded: {},
      msgItemDone: {},
      reasoningId: "",
      reasoningIndex: -1,
      reasoningBuf: "",
      reasoningPartAdded: false,
      reasoningDone: false,
      inThinking: false,
      funcArgsBuf: {},
      funcNames: {},
      funcCallIds: {},
      funcItemAdded: {},
      funcArgsDone: {},
      funcItemDone: {},
      customToolNames: new Set(),
      // Chat Completions usage for response.completed. Not state.usage: other translators in
      // the same pipeline overwrite that in their own shapes.
      responsesUsage: null,
      // finish_reason arrived before usage; response.completed waits for the usage chunk.
      completionPending: false,
      completedSent: false
    };
  }

  return base;
}

// Kept for backward compatibility; translators are already registered at import time.
export function initTranslators() {
  ensureInitialized();
}

// Static side-effect imports: each module calls register() at load (works in ESM + bundler).
import "./request/claude-to-openai.js";
import "./request/openai-to-claude.js";
import "./request/gemini-to-openai.js";
import "./request/openai-to-gemini.js";
import "./request/openai-to-vertex.js";
import "./request/antigravity-to-openai.js";
import "./request/openai-responses.js";
import "./request/openai-to-kiro.js";
import "./request/openai-to-cursor.js";
import "./request/openai-to-ollama.js";
import "./request/openai-to-commandcode.js";
import "./request/claude-to-kiro.js";
import "./response/claude-to-openai.js";
import "./response/openai-to-claude.js";
import "./response/gemini-to-openai.js";
import "./response/openai-to-antigravity.js";
import "./response/openai-responses.js";
import "./response/kiro-to-openai.js";
import "./response/cursor-to-openai.js";
import "./response/ollama-to-openai.js";
import "./response/commandcode-to-openai.js";
import "./response/kiro-to-claude.js";
