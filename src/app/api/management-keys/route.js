import { listManagementKeys, createManagementKeyFromDashboard } from "@/lib/management/dashboardHandlers.js";

export const dynamic = "force-dynamic";

// Dashboard only (session login). A management key can't reach this route:
// dashboardGuard accepts management keys on /api/management/v1/* alone.

// GET /api/management-keys - every management key, what each created, and the recent audit log
export async function GET() {
  return listManagementKeys();
}

// POST /api/management-keys - create one; the response carries its secret, once
export async function POST(request) {
  return createManagementKeyFromDashboard(request);
}
