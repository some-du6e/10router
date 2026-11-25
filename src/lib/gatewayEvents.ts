// Events the Go gateway (gateway/, docs/GO_GATEWAY.md) hands Node to write,
// so Node's own writers, locks and caches apply them: today the beta flags an
// endpoint rejected during a request the gateway served
// ("betas-learned", which chat.ts's saveDroppedBetas writes).
//
// Only the gateway this process runs behind can send one: a request from
// this machine (isLocalRequest) carrying the token the gateway started Node
// with, which custom-server.js checks (verifyGatewayToken) without exposing.

import { readJsonObject } from "@/sse/utils/requestBody.js";

export const GATEWAY_EVENTS_TOKEN_HEADER = "x-9r-gw-events-token";
// Node's events route; gateway/internal/nodeevents posts here.
export const GATEWAY_EVENTS_PATH = "/api/internal/gateway/events";
export const VERIFY_GATEWAY_TOKEN = Symbol.for("10router.verifyGatewayToken");

// Bounds on what is read; saveDroppedBetas itself keeps only flag names, at
// most 50 (sanitizeNodeQuirks), as when Node learns them.
const MAX_FLAGS = 200;
const MAX_FLAG_LENGTH = 256;

interface Connection {
  id: string;
  provider?: string;
  providerSpecificData?: Record<string, unknown>;
}

export interface GatewayEventDeps {
  isLocalRequest: (request: Request) => boolean;
  verifyToken: ((token: string | null) => boolean) | undefined;
  getConnection: (id: string) => Promise<Connection | null>;
  saveDroppedBetas: (credentials: { connectionId: string; providerSpecificData?: Record<string, unknown> }, provider: string, flags: string[]) => Promise<void>;
}

const json = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } });

export async function handleGatewayEvent(request: Request, deps: GatewayEventDeps): Promise<Response> {
  // Not behind the gateway, or not from it: as if there were no such route.
  if (typeof deps.verifyToken !== "function" || !deps.isLocalRequest(request) || !deps.verifyToken(request.headers.get(GATEWAY_EVENTS_TOKEN_HEADER))) {
    return json(404, "Not found");
  }
  const read = await readJsonObject(request);
  if (read.error) return read.error;
  const event = read.body as Record<string, unknown>;
  if (event.type !== "betas-learned") return json(400, "Unknown event type");
  const { connectionId, provider, droppedBetas } = event;
  if (typeof connectionId !== "string" || !connectionId || typeof provider !== "string" || !provider) {
    return json(400, "connectionId and provider are required");
  }
  if (!Array.isArray(droppedBetas) || droppedBetas.length === 0 || droppedBetas.length > MAX_FLAGS
    || !droppedBetas.every((f) => typeof f === "string" && f.length <= MAX_FLAG_LENGTH)) {
    return json(400, `droppedBetas must be 1 to ${MAX_FLAGS} strings`);
  }
  const connection = await deps.getConnection(connectionId);
  if (!connection || connection.provider !== provider) return json(404, "No such connection for that provider");
  await deps.saveDroppedBetas({ connectionId, providerSpecificData: connection.providerSpecificData }, provider, droppedBetas as string[]);
  return new Response(null, { status: 204 });
}
