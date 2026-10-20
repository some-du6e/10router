import { getCombos, getProviderConnections } from "@/lib/db/index.js";
import { AI_PROVIDERS } from "@/shared/constants/providers.js";
import { CLAUDE_BLOCK } from "open-sse/translator/schema/index.js";
import { handleSearch } from "../handlers/search.js";
import { buildSideSearchMessage, getSideSearchQuery, sideSearchResponse } from "./claudeSearchShortcut.js";

const enrichmentCache = new WeakMap();

// The search model only changes when combos or connections are edited, so a
// short TTL saves two table reads on every search without going stale for long.
const MODEL_TTL_MS = 30_000;
let modelCache = null;

// Agents often repeat a query within a session (retries, subagents). Results
// are kept briefly; only successful searches are cached.
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

export async function resolveBuiltinSearchModel() {
  if (modelCache && modelCache.expires > Date.now()) return modelCache.value;
  const value = await lookupBuiltinSearchModel();
  modelCache = { value, expires: Date.now() + MODEL_TTL_MS };
  return value;
}

async function lookupBuiltinSearchModel() {
  const combos = await getCombos();
  const combo = combos.find((candidate) => candidate.kind === "webSearch" && candidate.models?.length);
  if (combo) return combo.name;

  const connections = await getProviderConnections({ isActive: true });
  const connection = connections.find(({ provider }) => AI_PROVIDERS[provider]?.serviceKinds?.includes("webSearch"));
  if (connection) return connection.provider;

  const noAuth = Object.values(AI_PROVIDERS).find(
    (provider) => provider.noAuth && provider.serviceKinds?.includes("webSearch")
  );
  return noAuth?.id || null;
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
  if (hit && hit.expires > Date.now()) return hit.data;
  const data = await fetchGatewaySearch(args);
  resultCache.delete(key);
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
} = {}) {
  if (provider === "claude") return body;
  const searchRequest = getBuiltinSearchRequest(body);
  if (!searchRequest) return body;
  if (enrichmentCache.has(body)) return enrichmentCache.get(body);

  const task = (async () => {
    try {
      const model = await resolveSearchModel();
      if (!model) {
        log?.warn?.("SEARCH", "Claude built-in web search requested, but no web-search provider is configured");
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
 * request is not one, or when no search provider is configured, so the caller
 * carries on with normal routing.
 */
export async function answerClaudeSideSearch(body, {
  provider,
  model,
  request,
  apiKey,
  log,
  search = runGatewaySearch,
  resolveSearchModel = resolveBuiltinSearchModel,
} = {}) {
  if (provider === "claude") return null;
  const query = getSideSearchQuery(body);
  if (!query) return null;
  const searchRequest = { ...getBuiltinSearchRequest(body), query };

  let searchModel;
  try {
    searchModel = await resolveSearchModel();
  } catch (error) {
    log?.warn?.("SEARCH", `Web search side request skipped: model lookup failed: ${error.message}`);
    return null;
  }
  if (!searchModel) return null;

  let data = null;
  const started = Date.now();
  try {
    data = await search({ model: searchModel, searchRequest, request, apiKey });
    log?.info?.("SEARCH", `Answered web search side request via ${searchModel} in ${Date.now() - started}ms (${data?.results?.length || 0} results, skipped ${provider})`);
  } catch (error) {
    log?.warn?.("SEARCH", `Web search side request failed via ${searchModel}: ${error.message}`);
  }
  const message = buildSideSearchMessage(model || body.model, query, data);
  return sideSearchResponse(message, body.stream === true);
}
