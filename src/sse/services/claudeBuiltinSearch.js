import { getCombos, getProviderConnections } from "@/lib/db/index.js";
import { AI_PROVIDERS } from "@/shared/constants/providers.js";
import { CLAUDE_BLOCK } from "open-sse/translator/schema/index.js";
import { saveRequestDetail } from "@/lib/usageDb.js";
import { buildRequestDetail, extractRequestConfig } from "open-sse/handlers/chatCore/requestDetail.js";
import { handleSearch } from "../handlers/search.js";
import { buildSideSearchMessage, getSideSearchQuery, sideSearchResponse } from "./claudeSearchShortcut.js";
import { connectionBilling } from "./autoCombo.js";

const enrichmentCache = new WeakMap();

// Upstreams that run Anthropic's web_search server tool themselves.
const NATIVE_SEARCH_PROVIDERS = new Set(["claude", "anthropic"]);

// The search model only changes when combos or connections are edited, so a
// short TTL saves two table reads on every search without going stale for long.
const MODEL_TTL_MS = 30_000;
const modelCache = new Map();

// Agents often repeat a query within a session (retries, subagents). Results
// are kept briefly; only searches that returned results are cached.
const RESULT_TTL_MS = 5 * 60_000;
const RESULT_CACHE_MAX = 200;
const resultCache = new Map();

function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === CLAUDE_BLOCK.TEXT && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

export function getBuiltinSearchRequest(body) {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const tool = tools.find((candidate) => candidate?.type === CLAUDE_BLOCK.WEB_SEARCH_TOOL);
  if (!tool) return null;

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const userMessage = [...messages].reverse().find((message) => message?.role === "user");
  const query = extractText(userMessage?.content).trim();
  if (!query) return null;

  return {
    query,
    maxResults: 5,
    allowedDomains: Array.isArray(tool.allowed_domains) ? tool.allowed_domains : undefined,
    blockedDomains: Array.isArray(tool.blocked_domains) ? tool.blocked_domains : undefined,
  };
}

export function buildGatewaySearchBody(model, searchRequest) {
  const allowedDomains = searchRequest.allowedDomains || [];
  const blockedDomains = (searchRequest.blockedDomains || [])
    .map((domain) => typeof domain === "string" ? domain.replace(/^-+/, "") : "")
    .filter(Boolean)
    .map((domain) => `-${domain}`);

  return {
    model,
    query: searchRequest.query,
    max_results: searchRequest.maxResults,
    domain_filter: [...allowedDomains, ...blockedDomains],
  };
}

/**
 * The search provider or combo to answer Claude's web_search with. With
 * blockedBilling (an auto combo's request), a provider qualifies only if every
 * one of its accounts is allowed, since the search may pick any of them.
 */
export async function resolveBuiltinSearchModel(blockedBilling = null) {
  const key = blockedBilling ? [...blockedBilling].sort().join(",") : "";
  const cached = modelCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  const value = await lookupBuiltinSearchModel(blockedBilling);
  // Not caching "none configured", so a newly added provider is used at once.
  if (value) modelCache.set(key, { value, expires: Date.now() + MODEL_TTL_MS });
  else modelCache.delete(key);
  return value;
}

async function lookupBuiltinSearchModel(blockedBilling) {
  const combos = await getCombos();
  const combo = combos.find((candidate) => candidate.kind === "webSearch" && candidate.models?.length);
  if (combo) return combo.name;

  const allowed = (conn) => !blockedBilling || !blockedBilling.has(connectionBilling(conn));
  const searchable = (provider) => provider?.serviceKinds?.includes("webSearch") && provider.configured !== false;
  const connections = await getProviderConnections({ isActive: true });
  const connection = connections.find(({ provider }) =>
    searchable(AI_PROVIDERS[provider]) &&
    connections.filter((c) => c.provider === provider).every(allowed));
  if (connection) return connection.provider;

  const noAuth = Object.values(AI_PROVIDERS).find(
    (provider) => provider.noAuth && searchable(provider) && allowed({ provider: provider.id })
  );
  return noAuth?.id || null;
}

async function noSearchProviderMessage(blockedBilling, resolveSearchModel) {
  const base = "Claude built-in web search requested, but no web-search provider is";
  if (blockedBilling?.size && await resolveSearchModel(null)) {
    return `${base} allowed by auto-combo billing (blocked: ${[...blockedBilling].join(", ")}). ` +
      "Add a Web Search combo to allow one";
  }
  return `${base} configured (connect one, or set SEARXNG_URL)`;
}

function formatSearchContext(data) {
  const results = Array.isArray(data?.results) ? data.results : [];
  if (!results.length) return "";
  return results.map((result, index) => {
    const title = result.title || "Untitled result";
    const url = result.url || result.link || "";
    const excerpt = result.snippet || result.content || result.text || "";
    return `[${index + 1}] ${title}\nURL: ${url}\n${excerpt}`.trim();
  }).join("\n\n");
}

function resultCacheKey(model, searchRequest) {
  return JSON.stringify([model, searchRequest.query, searchRequest.maxResults, searchRequest.allowedDomains, searchRequest.blockedDomains]);
}

async function runGatewaySearch(args) {
  const key = resultCacheKey(args.model, args.searchRequest);
  const hit = resultCache.get(key);
  resultCache.delete(key);
  if (hit && hit.expires > Date.now()) {
    resultCache.set(key, hit);
    return hit.data;
  }
  const data = await fetchGatewaySearch(args);
  if (!data?.results?.length) return data;
  resultCache.set(key, { data, expires: Date.now() + RESULT_TTL_MS });
  if (resultCache.size > RESULT_CACHE_MAX) resultCache.delete(resultCache.keys().next().value);
  return data;
}

async function fetchGatewaySearch({ model, searchRequest, request, apiKey }) {
  const headers = new Headers({ "Content-Type": "application/json" });
  const authorization = request?.headers?.get("authorization");
  if (authorization) headers.set("Authorization", authorization);
  else if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);

  const response = await handleSearch(new Request("http://localhost/v1/search", {
    method: "POST",
    headers,
    body: JSON.stringify(buildGatewaySearchBody(model, searchRequest)),
  }));
  if (!response.ok) throw new Error(`search returned HTTP ${response.status}`);
  return response.json();
}

export async function enrichClaudeBuiltinSearch(body, {
  provider,
  request,
  apiKey,
  log,
  search = runGatewaySearch,
  resolveSearchModel = resolveBuiltinSearchModel,
  blockedBilling = null,
} = {}) {
  if (NATIVE_SEARCH_PROVIDERS.has(provider)) return body;
  const searchRequest = getBuiltinSearchRequest(body);
  if (!searchRequest) return body;
  if (enrichmentCache.has(body)) return enrichmentCache.get(body);

  const task = (async () => {
    try {
      const model = await resolveSearchModel(blockedBilling);
      if (!model) {
        log?.warn?.("SEARCH", await noSearchProviderMessage(blockedBilling, resolveSearchModel));
        return body;
      }
      const data = await search({ model, searchRequest, request, apiKey });
      const context = formatSearchContext(data);
      if (!context) return body;

      const tools = body.tools.filter((tool) => tool?.type !== CLAUDE_BLOCK.WEB_SEARCH_TOOL);
      const instruction = [
        "10router executed the requested web search. Use the sources below to answer the user's request.",
        "Cite source URLs in the answer and do not claim that web search was unavailable.",
        "",
        context,
      ].join("\n");
      const system = Array.isArray(body.system)
        ? [...body.system, { type: CLAUDE_BLOCK.TEXT, text: instruction }]
        : [
            ...(body.system ? [{ type: CLAUDE_BLOCK.TEXT, text: String(body.system) }] : []),
            { type: CLAUDE_BLOCK.TEXT, text: instruction },
          ];

      log?.info?.("SEARCH", `Injected ${data.results.length} web result(s) for non-Claude provider ${provider}`);
      const enriched = { ...body, system, tools };
      if (!tools.length) {
        delete enriched.tools;
        delete enriched.tool_choice;
      }
      return enriched;
    } catch (error) {
      log?.warn?.("SEARCH", `Claude built-in web search failed open: ${error.message}`);
      return body;
    }
  })();
  enrichmentCache.set(body, task);
  return task;
}

/**
 * Answer a Claude Code WebSearch side request from the gateway's own search
 * provider instead of sending it to a non-Claude model. Returns null when the
 * request is not one, or when the search can't be run, so the caller carries on
 * with normal routing (and a combo can still fall back).
 */
export async function answerClaudeSideSearch(body, {
  provider,
  model,
  request,
  apiKey,
  log,
  search = runGatewaySearch,
  resolveSearchModel = resolveBuiltinSearchModel,
  recordDetail = saveRequestDetail,
  blockedBilling = null,
} = {}) {
  if (NATIVE_SEARCH_PROVIDERS.has(provider)) return null;
  const query = getSideSearchQuery(body);
  if (!query) return null;
  const searchRequest = { ...getBuiltinSearchRequest(body), query };

  let searchModel;
  try {
    searchModel = await resolveSearchModel(blockedBilling);
  } catch (error) {
    log?.warn?.("SEARCH", `Web search side request skipped: model lookup failed: ${error.message}`);
    return null;
  }
  if (!searchModel) return null;

  let data;
  const started = Date.now();
  try {
    data = await search({ model: searchModel, searchRequest, request, apiKey });
  } catch (error) {
    log?.warn?.("SEARCH", `Web search side request failed via ${searchModel}, routing to ${provider}: ${error.message}`);
    return null;
  }
  const elapsed = Date.now() - started;
  log?.info?.("SEARCH", `Answered web search side request via ${searchModel} in ${elapsed}ms (${data?.results?.length || 0} results, skipped ${provider})`);

  const stream = body.stream === true;
  const message = buildSideSearchMessage(model || body.model, query, data);
  recordDetail(buildRequestDetail({
    provider: "search",
    model: searchModel,
    latency: { ttft: elapsed, total: elapsed },
    request: extractRequestConfig(body, stream),
    response: { content: message.content, status: 200, thinking: null },
  }))?.catch?.(() => { });
  return sideSearchResponse(message, stream);
}
