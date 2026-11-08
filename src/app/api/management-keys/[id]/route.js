import { updateManagementKeyFromDashboard, revokeManagementKeyFromDashboard } from "@/lib/management/dashboardHandlers.js";

export const dynamic = "force-dynamic";

// PATCH /api/management-keys/[id] - rename, turn on/off, change expiry or scopes
export async function PATCH(request, { params }) {
  const { id } = await params;
  return updateManagementKeyFromDashboard(request, id);
}

// DELETE /api/management-keys/[id][?deleteCreated=1] - revoke: the key stops
// working at once. With deleteCreated, the keys it created go too.
export async function DELETE(request, { params }) {
  const { id } = await params;
  return revokeManagementKeyFromDashboard(request, id);
}
