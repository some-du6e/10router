// Exa's /search API (https://docs.exa.ai/reference/search), for every provider
// whose searchConfig has format "exa" (EXA_SEARCH_API in providers/shared.js).

type ExaSearchConfig = {
  authHeader?: string;
  defaultMode?: string;
  highlightMaxCharacters?: number;
};

type ExaSearchParams = {
  query: string;
  searchType?: string;
  maxResults: number;
  searchMode?: string | null;
  contentOptions?: { full_page?: boolean } | null;
};

type DomainFilter = { includes: string[]; excludes: string[] };

type ExaResult = { highlights?: unknown; text?: unknown };

// A result with no highlights gets this much of its page text as its snippet.
const TEXT_SNIPPET_CHARS = 300;
const HIGHLIGHT_SEPARATOR = " … ";

export function exaHeaders(config: ExaSearchConfig, token: string): Record<string, string> {
  const auth: Record<string, string> = config.authHeader === "bearer" ? { Authorization: `Bearer ${token}` } : { "x-api-key": token };
  return { "Content-Type": "application/json", ...auth };
}

/**
 * The /search body. Its search type is the mode the model names ("exa/instant",
 * which the search handler checks against searchConfig.modes), else the
 * provider's default. Page text comes too unless the caller shows only
 * snippets (content_options.full_page false), since a search without it
 * returns sooner.
 */
export function buildExaSearchBody(config: ExaSearchConfig, params: ExaSearchParams, domains: DomainFilter): Record<string, unknown> {
  const contents: Record<string, unknown> = { highlights: { maxCharacters: config.highlightMaxCharacters } };
  if (params.contentOptions?.full_page !== false) contents.text = true;
  const body: Record<string, unknown> = {
    query: params.query,
    type: params.searchMode || config.defaultMode,
    numResults: params.maxResults,
    contents,
  };
  if (domains.includes.length) body.includeDomains = domains.includes;
  if (domains.excludes.length) body.excludeDomains = domains.excludes;
  if (params.searchType === "news") body.category = "news";
  return body;
}

/** A result's highlights joined into one snippet, else the start of its page text. */
export function exaSnippet(item: ExaResult): string {
  const highlights = Array.isArray(item.highlights)
    ? item.highlights.filter((h): h is string => typeof h === "string").map((h) => h.replace(/\s+/g, " ").trim()).filter(Boolean)
    : [];
  if (highlights.length) return highlights.join(HIGHLIGHT_SEPARATOR);
  return typeof item.text === "string" ? item.text.slice(0, TEXT_SNIPPET_CHARS) : "";
}
