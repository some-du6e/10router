// Exa's /search API (https://docs.exa.ai/reference/search), for every provider
// whose searchConfig has api "exa" (EXA_SEARCH_API in providers/shared.js).

export type ExaSearchConfig = {
  authHeader?: string;
  modes?: string[];
  defaultMode?: string;
  highlightMaxCharacters?: number;
};

export type ExaSearchParams = {
  query: string;
  searchType?: string;
  maxResults: number;
  token?: string;
  searchMode?: string;
  contentOptions?: { full_page?: boolean } | null;
  providerOptions?: Record<string, unknown> | null;
};

export type DomainFilter = { includes: string[]; excludes: string[] };

type ExaResult = { highlights?: unknown; text?: unknown };

// A result with no highlights gets this much of its page text as its snippet.
const TEXT_SNIPPET_CHARS = 300;
const HIGHLIGHT_SEPARATOR = " … ";

/**
 * The Exa search type: `provider_options.type`, else the mode the model names
 * ("exa/instant"), else the provider's default. Throws for a type the provider
 * doesn't list, before anything is sent.
 */
export function exaSearchType(config: ExaSearchConfig, params: ExaSearchParams): string | undefined {
  const requested = params.providerOptions?.type ?? params.searchMode;
  if (requested === undefined || requested === null || requested === "") return config.defaultMode;
  const modes = config.modes ?? [];
  if (typeof requested !== "string" || !modes.includes(requested)) {
    throw new Error(`Unknown Exa search type ${JSON.stringify(requested)}: use one of ${modes.join(", ")}`);
  }
  return requested;
}

export function exaHeaders(config: ExaSearchConfig, token: string | undefined): Record<string, string> {
  const key = token ?? "";
  const auth: Record<string, string> = config.authHeader === "bearer" ? { Authorization: `Bearer ${key}` } : { "x-api-key": key };
  return { "Content-Type": "application/json", ...auth };
}

/**
 * The /search body. Contents go in `contents`, where Exa reads them. Page text
 * comes too unless the caller shows only snippets (content_options.full_page
 * false), since a search without it returns sooner.
 */
export function buildExaSearchBody(config: ExaSearchConfig, params: ExaSearchParams, domains: DomainFilter): Record<string, unknown> {
  const contents: Record<string, unknown> = {
    highlights: config.highlightMaxCharacters ? { maxCharacters: config.highlightMaxCharacters } : true,
  };
  if (params.contentOptions?.full_page !== false) contents.text = true;

  const body: Record<string, unknown> = { query: params.query };
  const type = exaSearchType(config, params);
  if (type) body.type = type;
  body.numResults = params.maxResults;
  body.contents = contents;
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
