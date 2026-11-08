import { updateManagementKeyFromDashboard, revokeManagementKeyFromDashboard } from "@/lib/management/dashboardHandlers.js";

export const dynamic = "force-dynamic";

// PATCH /api/management-keys/[id] - rename, turn on/off, change expiry or scopes
export async function PATCH(request, { params }) {
  const { id } = await params;
  return updateManagementKeyFromDashboard(request, id);
}

// DELETE /api/management-keys/[id] - revoke: the key stops working at once
export async function DELETE(request, { params }) {
  const { id } = await params;
  return revokeManagementKeyFromDashboard(id);
}
