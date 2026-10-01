import { getSettings } from "@/lib/db/index.js";
import { authorizeHub } from "@/lib/usageHub/auth.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

async function handle(request, { params }) {
  const denied = authorizeHub(request, await getSettings());
  if (denied) return json({ error: denied === 404 ? "Hub disabled" : "Invalid management key" }, denied);
  const { action } = await params;
  const method = { "auth-files": "GET", "api-call": "POST", "reset-quota": "POST" }[action];
  if (!method) return json({ error: "Unknown management endpoint" }, 404);
  if (request.method !== method) return json({ error: "Method not allowed" }, 405);
  let body;
  if (method === "POST") {
    const text = await request.text();
    if (text.length > 16384) return json({ error: "Request too large" }, 413);
    try { body = JSON.parse(text); } catch { return json({ error: "Invalid JSON" }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Invalid request" }, 400);
  }
  try {
    const { listHubAccounts, hubApiCall, resetHubQuota } = await import("@/lib/usageHub/service.js");
    return json(await (action === "auth-files" ? listHubAccounts() : action === "api-call" ? hubApiCall(body) : resetHubQuota(body)));
  } catch (error) {
    return json({ error: error.status ? error.message : "Hub could not read the provider response" }, error.status || 502);
  }
}

export const GET = handle;
export const POST = handle;
