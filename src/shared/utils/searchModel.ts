// A web search model is a provider id or alias, or one with a search mode the
// provider lists in searchConfig.modes after a "/" ("exa/instant"). "/search"
// is the id /v1/models lists for every search provider, and names no mode.
export const SEARCH_MODEL_ID = "search";

type SearchConfig = { modes?: string[]; defaultMode?: string };
type SearchProviderInfo = { name?: string; searchConfig?: SearchConfig };

export function parseSearchModel(model: string): { provider: string; mode: string | null } {
  const slash = model.indexOf("/");
  if (slash < 0) return { provider: model, mode: null };
  const mode = model.slice(slash + 1);
  return { provider: model.slice(0, slash), mode: mode === SEARCH_MODEL_ID ? null : mode };
}

/** Why a model's mode can't be used with the provider, or null when it can (or names none). */
export function searchModeError(providerId: string, mode: string | null, searchConfig?: SearchConfig | null): string | null {
  if (mode === null) return null;
  const modes = searchConfig?.modes ?? [];
  if (modes.includes(mode)) return null;
  if (!modes.length) return `${providerId} has no search modes, so "${providerId}/${mode}" can't be used`;
  return `Unknown search mode "${mode}" for ${providerId}: use one of ${modes.join(", ")}`;
}

/** The model picker's entries for a search provider: the provider (its default mode), then each other mode. */
export function searchModelChoices(providerId: string, info?: SearchProviderInfo | null): { id: string; name: string; value: string }[] {
  const name = info?.name || providerId;
  const config: SearchConfig = info?.searchConfig ?? {};
  const { modes = [], defaultMode } = config;
  const choices = [{ id: providerId, name, value: providerId }];
  for (const mode of modes) {
    if (mode === defaultMode) continue;
    const value = `${providerId}/${mode}`;
    choices.push({ id: value, name: `${name} · ${mode}`, value });
  }
  return choices;
}
