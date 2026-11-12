import { listClientKeys, createClientKey } from "@/lib/management/handlers.js";

export const dynamic = "force-dynamic";

// GET /api/management/v1/client-keys - client keys this management key can see
export async function GET(request) {
  return listClientKeys(request);
}

// POST /api/management/v1/client-keys - create a client key inside the scope
export async function POST(request) {
  return createClientKey(request);
}
