import { getModelAliases, getComboByName } from "@/lib/localDb";
import { stripContextWindowSuffix, BUILTIN_MODEL_ALIASES } from "open-sse/services/model.js";
import { getAutoComboCatalogMatches, resolveAutoCombo, setRequestAutoCombo } from "./autoCombo.js";

// A bare model name reaching the shared handler is treated as an alias, and an
// unmatched alias is guessed at by name — which lands on OpenAI for anything
// shaped like `gpt-*`. That is the wrong default on the Codex wire: Codex asks
// for models of its own that we would then send to a provider the user very
// likely has no key for.
//
// Codex also asks for models the user never chose. Its side requests (thread
// titles among them) carry a small model of Codex's own picking, not the model
// configured for the session, so the name cannot be assumed to be one the user
// has set up.
//
// So a bare model goes to Codex (`cx/`), except: an explicit `provider/model`,
// a model alias or a combo resolves the way it always did, and a model other
// providers serve gets an auto combo, with Codex accounts first when Codex
// serves it too. Compactions (`_compact`) only Codex understands, so they
// never fall back past it.
export async function routeCodexRequest(request: Request, extraBody: Record<string, unknown> = {}): Promise<Request> {
  let body: Record<string, unknown> | null;
  try {
    body = await request.clone().json();
  } catch {
    return request; // not JSON — let the shared handler reject it as it would
  }
  const withModel = (model: unknown) => new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify({ ...body, ...extraBody, model }),
    signal: request.signal,
  });
  // The client's own request when nothing changes, so it reaches handleChat as sent.
  const unchanged = () => (Object.keys(extraBody).length ? withModel(body?.model) : request);

  const model = body?.model;
  if (typeof model !== "string" || !model || model.includes("/")) return unchanged();

  // A client-side context selector ("claude-opus-5[1m]") is not part of any
  // stored name, so it has to come off before the alias/combo lookup — the same
  // way handleChat strips it before routing. Without this, the plain id matches
  // its combo and routes to Claude while the [1m] variant misses, falls through
  // to `cx/`, and dies upstream as "model is not supported ... with a ChatGPT
  // account". The marker stays on the forwarded body; handleChat strips it.
  const { model: bareModel } = stripContextWindowSuffix(model);

  const aliases = (await getModelAliases()) as Record<string, unknown> | null;
  if (aliases?.[bareModel] || (BUILTIN_MODEL_ALIASES as Record<string, unknown>)[bareModel]) return unchanged();
  if (await getComboByName(bareModel)) return unchanged();

  // resolveAutoCombo waits out a cold catalog, so call it before reading
  // getAutoComboCatalogMatches.
  const models = await resolveAutoCombo(bareModel, BUILTIN_MODEL_ALIASES, { preferProvider: "codex" });
  const codexIds = getAutoComboCatalogMatches(bareModel).filter((m) => m.provider === "codex").map((m) => m.id);
  if (models) {
    // Whenever Codex serves the model, Codex alone keeps it unless the combo
    // also has Codex and somewhere else to fall back to. Codex left out by auto
    // combo settings still serves it here: this is Codex's own door.
    const fallsBackPastCodex = models.some((m) => codexIds.includes(m)) && models.some((m) => !codexIds.includes(m));
    if (codexIds.length === 0 || (fallsBackPastCodex && !extraBody._compact)) {
      const routed = unchanged();
      setRequestAutoCombo(routed, models);
      return routed;
    }
  }
  // Catalog matching ignores case, dots and a leading `openai-`, so send the
  // id Codex lists rather than the client's spelling of it.
  const codexId = codexIds[0];
  return withModel(codexId ? codexId + model.slice(bareModel.length) : `cx/${model}`);
}
