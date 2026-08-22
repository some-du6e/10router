import { getCombos, getProviderConnections } from "@/lib/db/index.js";
import { AI_PROVIDERS } from "@/shared/constants/providers.js";
import { CLAUDE_BLOCK } from "open-sse/translator/schema/index.js";
import { handleSearch } from "../handlers/search.js";

const enrichmentCache = new WeakMap();

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
    maxResults: Math.max(1, Math.min(Number(tool.max_uses) || 5, 10)),
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

async function runGatewaySearch({ model, searchRequest, request, apiKey }) {
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
