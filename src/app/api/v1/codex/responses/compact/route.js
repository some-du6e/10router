// Codex-native ingress: POST /backend-api/codex/responses/compact
// Same pipeline as /v1/responses/compact (see ../route.js for why the mirror
// exists), with the main turn's Codex model routing, except that a compaction
// never falls back past Codex. Like /v1/responses/compact, no early headers.
import { handleChat } from "@/sse/handlers/chat.js";
import { initTranslators } from "open-sse/translator/index.js";
import { routeCodexRequest } from "@/sse/services/codexIngress.js";
import { withMemoryAdmission, carryAdmission } from "@/sse/services/memoryAdmission.js";

export { OPTIONS } from "../../../responses/compact/route.js";

// Admitted before routeCodexRequest reads the body; handleChat runs under the
// same admission.
export function POST(request) {
  return withMemoryAdmission(request, async () => {
    initTranslators();
    const routed = await routeCodexRequest(request, { compact: true });
    return handleChat(carryAdmission(request, routed.request));
  });
}
