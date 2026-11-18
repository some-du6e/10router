import { listProviderKeys, createProviderKey } from "@/lib/management/handlers.js";

export const dynamic = "force-dynamic";

// GET /api/management/v1/provider-keys[?provider=<id>] - provider keys this management key can see
export async function GET(request) {
  return listProviderKeys(request);
}

// POST /api/management/v1/provider-keys - validate and add an upstream key for a provider in scope
export async function POST(request) {
  return createProviderKey(request);
}
