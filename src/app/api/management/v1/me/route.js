import { getMe } from "@/lib/management/handlers.js";

export const dynamic = "force-dynamic";

// GET /api/management/v1/me - the calling management key's own name and scopes
export async function GET(request) {
  return getMe(request);
}
