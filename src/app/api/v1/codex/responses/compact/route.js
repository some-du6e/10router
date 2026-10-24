// Codex-native ingress: POST /backend-api/codex/responses/compact
// Same pipeline as /v1/responses/compact (see ../route.js for why the mirror
// exists), with the main turn's Codex model routing, except that a compaction
// never falls back past Codex.
import { handleChat } from "@/sse/handlers/chat.js";
import { initTranslators } from "open-sse/translator/index.js";
import { routeCodexRequest } from "@/sse/services/codexIngress.js";

export { OPTIONS } from "../../../responses/compact/route.js";

export async function POST(request) {
  initTranslators();
  return handleChat(await routeCodexRequest(request, { _compact: true }));
}
