import { getSettings, updateSettings } from "@/lib/db/index.js";
import { createManagementKey, hubConfig } from "@/lib/usageHub/auth.js";

export const dynamic = "force-dynamic";
const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function GET() {
  return json(hubConfig(await getSettings()));
}

export async function PATCH(request) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  if (typeof body?.enabled !== "boolean") return json({ error: "enabled must be a boolean" }, 400);
  const settings = await getSettings();
  const generated = body.enabled && !settings.usageHubKeyHash ? createManagementKey() : null;
  const updated = await updateSettings({
    usageHubEnabled: body.enabled,
    ...(generated ? { usageHubKeyHash: generated.hash } : {}),
  });
  return json({ ...hubConfig(updated), ...(generated ? { managementKey: generated.key } : {}) });
}

export async function POST() {
  const generated = createManagementKey();
  const settings = await updateSettings({ usageHubKeyHash: generated.hash });
  return json({ ...hubConfig(settings), managementKey: generated.key });
}
