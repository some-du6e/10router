// Codex-native ingress: POST /backend-api/codex/responses
//
// The Codex CLI/IDE talks to `<base_url>/responses` when it is configured with
// `wire_api = "responses"`. Pointing it at the plain `/v1` ingress works, but
// Codex only serves its native model catalog and ChatGPT-style auth from a
// `/backend-api/codex` base URL — so this mirror exists to accept that shape.
// The body is the same OpenAI Responses payload, so it reuses the /v1/responses
// handler untouched (see next.config.mjs for the /backend-api/codex rewrites).
import { POST as responsesPost } from "../../responses/route.js";
import { getPooledCodexRateLimitHeaders } from "@/sse/services/codexPooledUsage";
import { getModelAliases, getComboByName } from "@/lib/localDb";

export { OPTIONS } from "../../responses/route.js";

// A bare model name reaching the shared handler is treated as an alias, and an
// unmatched alias is guessed at by name — which lands on OpenAI for anything
// shaped like `gpt-*`. That is the wrong default here: this door is the Codex
// wire, and Codex asks for models of its own that we would then send to a
// provider the user very likely has no key for.
//
// Codex also asks for models the user never chose. Its side requests (thread
// titles among them) carry a small model of Codex's own picking, not the model
// configured for the session, so the name cannot be assumed to be one the user
// has set up.
//
// Only the fallback changes: an explicit `provider/model`, a model alias, or a
// combo still resolves the way it always did, so pointing Codex at Claude or
// anything else through this endpoint keeps working.
async function withCodexFallback(request) {
  let body;
  try {
    body = await request.clone().json();
  } catch {
    return request; // not JSON — let the shared handler reject it as it would
  }

  const model = body?.model;
  if (typeof model !== "string" || !model || model.includes("/")) return request;

  const aliases = await getModelAliases();
  if (aliases?.[model]) return request;
  if (await getComboByName(model)) return request;

  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify({ ...body, model: `cx/${model}` }),
  });
}

export async function POST(request) {
  const response = await responsesPost(await withCodexFallback(request));

  // Codex reads its usage bar off these headers rather than from an endpoint.
  // Requests are served from all connected Codex accounts, so report the pooled
  // number. Cached and refreshed in the background — never blocks the reply.
  const pooled = getPooledCodexRateLimitHeaders();
  if (Object.keys(pooled).length === 0) return response;

  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(pooled)) headers.set(name, value);

  // Re-wrap rather than mutate: a streamed body must pass through untouched.
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
