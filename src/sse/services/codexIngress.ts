import { stripContextWindowSuffix, BUILTIN_MODEL_ALIASES } from "open-sse/services/model.js";
import { RESPONSES_ITEM } from "open-sse/translator/schema/index.js";
import { getAutoComboCatalogMatches, isPlainBareId, resolveAutoCombo } from "./autoCombo.js";
import { requestKeyAllowsModel } from "./keyLimits.js";

const CODEX_PROVIDER = "codex";

export interface CodexRoute {
  // The request to hand to handleChat: the client's own, or one with its model rewritten.
  request: Request;
  // An auto combo to route in this order, Codex members first; null routes the model as named.
  autoCombo: string[] | null;
  // The Codex members of autoCombo. When one is rate-limited and nothing behind
  // it answers, the request waits on it the way a plain `cx/` request does.
  autoComboHome: string[];
}

// Input items only Codex can read. After a compaction, every later turn
// carries Codex's encrypted compaction item, and the Responses to Chat
// translation other providers go through drops item types it doesn't know.
// Reasoning items translate (their encrypted part rides along), so they don't count.
function carriesCodexOnlyItems(body: Record<string, unknown> | null): boolean {
  const input = body?.input;
  return Array.isArray(input) && input.some((item) => (
    item && typeof item === "object" &&
    (item as { type?: unknown }).type !== RESPONSES_ITEM.REASONING &&
    typeof (item as { encrypted_content?: unknown }).encrypted_content === "string"
  ));
}

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
// serves it too. Compactions, and turns carrying a compaction, only Codex
// understands, so they never fall back past it.
export async function routeCodexRequest(request: Request, { compact = false }: { compact?: boolean } = {}): Promise<CodexRoute> {
  const route = (req: Request, autoCombo: string[] | null = null, autoComboHome: string[] = []): CodexRoute => ({ request: req, autoCombo, autoComboHome });
  let body: Record<string, unknown> | null;
  try {
    body = await request.clone().json();
  } catch {
    return route(request); // not JSON — let the shared handler reject it as it would
  }
  const withModel = (model: unknown) => new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify({ ...body, ...(compact ? { _compact: true } : {}), model }),
    signal: request.signal,
  });
  // The client's own request when nothing changes, so it reaches handleChat as sent.
  const unchanged = () => (compact ? withModel(body?.model) : request);

  const model = body?.model;
  if (typeof model !== "string" || !model || model.includes("/")) return route(unchanged());

  // A client-side context selector ("claude-opus-5[1m]") is not part of any
  // stored name, so it has to come off before the alias/combo lookup — the same
  // way handleChat strips it before routing. Without this, the plain id matches
  // its combo and routes to Claude while the [1m] variant misses, falls through
  // to `cx/`, and Codex rejects it upstream as unsupported for a ChatGPT
  // account. The marker stays on the forwarded body; handleChat strips it.
  const { model: bareModel } = stripContextWindowSuffix(model);
  if (!(await isPlainBareId(bareModel, BUILTIN_MODEL_ALIASES))) return route(unchanged());

  // resolveAutoCombo waits out a cold catalog, so call it before reading
  // getAutoComboCatalogMatches.
  const models = await resolveAutoCombo(bareModel, BUILTIN_MODEL_ALIASES);
  const codexIds = getAutoComboCatalogMatches(bareModel).filter((m) => m.provider === CODEX_PROVIDER).map((m) => m.id);
  // A model Codex doesn't serve but others do routes as on /v1: handleChat
  // forms the auto combo itself, with its usual strategy and hold.
  if (models && codexIds.length === 0) return route(unchanged());
  if (models) {
    const home = models.filter((m) => codexIds.includes(m));
    // Whenever Codex serves the model, Codex alone keeps it unless the combo
    // also has Codex and somewhere else to fall back to. Codex left out by auto
    // combo settings still serves it here: this is Codex's own ingress. So does
    // a client key allowed only the Codex model (`cx/<model>`), not the bare id.
    const fallsBackPastCodex = home.length > 0 && home.length < models.length;
    const staysOnCodex = compact || carriesCodexOnlyItems(body);
    if (fallsBackPastCodex && !staysOnCodex && await requestKeyAllowsModel(request, model)) {
      // Codex accounts first, the rest in the order the auto combo ranked them.
      return route(unchanged(), [...home, ...models.filter((m) => !home.includes(m))], home);
    }
  }
  // Catalog matching ignores case, dots and a leading `openai-`, so send the
  // id Codex lists rather than the client's spelling of it, unless the
  // client's key is allowed only the client's spelling.
  const clientPin = `cx/${model}`;
  const codexPin = codexIds[0] ? codexIds[0] + model.slice(bareModel.length) : clientPin;
  const pin = codexPin === clientPin || await requestKeyAllowsModel(request, codexPin) ? codexPin : clientPin;
  return route(withModel(pin));
}
