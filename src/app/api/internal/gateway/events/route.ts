// The Go gateway's events (src/lib/gatewayEvents.ts): writes it hands Node.
import { isLocalRequest } from "@/dashboardGuard.js";
import { getProviderConnectionById } from "@/lib/db/index.js";
import { handleGatewayEvent, VERIFY_GATEWAY_TOKEN, type GatewayEventDeps } from "@/lib/gatewayEvents.js";
import { saveDroppedBetas } from "@/sse/handlers/chat.js";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const verifyToken = (globalThis as unknown as Record<symbol, GatewayEventDeps["verifyToken"]>)[VERIFY_GATEWAY_TOKEN];
  return handleGatewayEvent(request, {
    isLocalRequest,
    verifyToken,
    getConnection: (id) => getProviderConnectionById(id),
    saveDroppedBetas: (credentials, provider, flags) => saveDroppedBetas(credentials as Parameters<typeof saveDroppedBetas>[0], provider, flags),
  });
}
