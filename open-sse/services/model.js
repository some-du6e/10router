import REGISTRY from "../providers/registry/index.js";

// Alias→id derived from registry single-source: id→id, alias→id, aliases[]→id.
// Media-only providers without a registry transport entry keep explicit aliases here.
const MEDIA_ONLY_ALIASES = {
  el: "elevenlabs",
  jina: "jina-ai",
  "jina-ai": "jina-ai",
  polly: "aws-polly",
  "aws-polly": "aws-polly",
};

const ALIAS_TO_PROVIDER_ID = { ...MEDIA_ONLY_ALIASES };
for (const entry of REGISTRY) {
  ALIAS_TO_PROVIDER_ID[entry.id] = entry.id;
  if (entry.alias) ALIAS_TO_PROVIDER_ID[entry.alias] = entry.id;
  for (const a of entry.aliases || []) ALIAS_TO_PROVIDER_ID[a] = entry.id;
}

const BUILTIN_MODEL_ALIASES = {
  "grok-build": "gcli/grok-build",
};

/**
 * Resolve provider alias to provider ID
 */
export function resolveProviderAlias(aliasOrId) {
  return ALIAS_TO_PROVIDER_ID[aliasOrId] || aliasOrId;
}

// Anthropic clients (Claude Code, and t3 code driving it) request an explicit
// context window by appending a bracketed suffix to the model id — e.g.
// "claude-opus-5[1m]". The suffix is a client-side selector, not part of any
// upstream catalogue id, so strip it before routing. Without this the id
// matches no alias, falls through to inferProviderFromModelName(), and is sent
// to the bare "anthropic" provider — 404 "No active credentials".
const CONTEXT_WINDOW_SUFFIX = /\[(\d+[km])\]$/i;

/**
 * Split a trailing context-window selector off a model id.
 * "claude-opus-5[1m]" -> { model: "claude-opus-5", contextWindow: "1m" }
 */
export function stripContextWindowSuffix(modelStr) {
  if (!modelStr) return { model: modelStr, contextWindow: null };
  const match = modelStr.match(CONTEXT_WINDOW_SUFFIX);
  if (!match) return { model: modelStr, contextWindow: null };
  return {
    model: modelStr.slice(0, match.index),
    contextWindow: match[1].toLowerCase(),
  };
}

/**
 * Parse model string: "alias/model" or "provider/model" or just alias
 */
export function parseModel(modelStr) {
  if (!modelStr) {
    return { provider: null, model: null, isAlias: false, providerAlias: null, contextWindow: null };
  }

  const { model: stripped, contextWindow } = stripContextWindowSuffix(modelStr);
  modelStr = stripped;

  // Check if standard format: provider/model or alias/model
  if (modelStr.includes("/")) {
    const firstSlash = modelStr.indexOf("/");
    const providerOrAlias = modelStr.slice(0, firstSlash);
    const model = modelStr.slice(firstSlash + 1);
    const provider = resolveProviderAlias(providerOrAlias);
    return { provider, model, isAlias: false, providerAlias: providerOrAlias, contextWindow };
  }

  // Alias format (model alias, not provider alias)
  return {
    provider: null,
    model: modelStr,
    isAlias: true,
    providerAlias: null,
    contextWindow,
  };
}

/**
 * Resolve model alias from aliases object
 * Format: { "alias": "provider/model" }
 */
export function resolveModelAliasFromMap(alias, aliases) {
  if (!aliases) return null;

  // Check if alias exists
  const resolved = aliases[alias];
  if (!resolved) return null;

  // Resolved value is "provider/model" format
  if (typeof resolved === "string" && resolved.includes("/")) {
    const firstSlash = resolved.indexOf("/");
    const providerOrAlias = resolved.slice(0, firstSlash);
    return {
      provider: resolveProviderAlias(providerOrAlias),
      model: resolved.slice(firstSlash + 1),
    };
  }

  // Or object { provider, model }
  if (typeof resolved === "object" && resolved.provider && resolved.model) {
    return {
      provider: resolveProviderAlias(resolved.provider),
      model: resolved.model,
    };
  }

  return null;
}

/**
 * Get full model info (parse or resolve)
 * @param {string} modelStr - Model string
 * @param {object|function} aliasesOrGetter - Aliases object or async function to get aliases
 */
export async function getModelInfoCore(modelStr, aliasesOrGetter) {
  const parsed = parseModel(modelStr);

  if (!parsed.isAlias) {
    return withContextWindow({ provider: parsed.provider, model: parsed.model }, parsed);
  }

  // Get aliases (from object or function)
  const aliases =
    typeof aliasesOrGetter === "function"
      ? await aliasesOrGetter()
      : aliasesOrGetter;

  // Resolve alias
  const resolved =
    resolveModelAliasFromMap(parsed.model, aliases) ||
    resolveModelAliasFromMap(parsed.model, BUILTIN_MODEL_ALIASES);
  if (resolved) {
    return withContextWindow(resolved, parsed);
  }

  // Fallback: infer provider from model name prefix
  return withContextWindow(
    { provider: inferProviderFromModelName(parsed.model), model: parsed.model },
    parsed,
  );
}

/**
 * Carry a requested context window through to a resolved {provider, model}.
 * The key is omitted entirely when the id carried no selector, so callers that
 * compare the resolved pair by value keep seeing the shape they always did.
 */
export function withContextWindow(info, parsed) {
  return parsed?.contextWindow ? { ...info, contextWindow: parsed.contextWindow } : info;
}

// Config-driven prefix → provider inference (first match wins, fallback "openai").
const MODEL_PREFIX_PROVIDERS = [
  [/^claude-/, "anthropic"],
  [/^gemini-/, "gemini"],
  [/^gpt-/, "openai"],
  [/^o[134]/, "openai"],
  [/^deepseek-/, "openrouter"],
];

/**
 * Infer provider from model name prefix
 * Used as fallback when no provider prefix or alias is given
 */
function inferProviderFromModelName(modelName) {
  if (!modelName) return "openai";
  const m = modelName.toLowerCase();
  return MODEL_PREFIX_PROVIDERS.find(([re]) => re.test(m))?.[1] || "openai";
}
