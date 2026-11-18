import { NextResponse } from "next/server";
import { deleteApiKey, getApiKeyById } from "@/lib/localDb";
import { parseKeyLimitsInput } from "@/shared/utils/apiKeyLimits.js";
import { updateApiKeyAs } from "@/lib/db/repos/managementKeysRepo.js";

export const dynamic = "force-dynamic";

// GET /api/keys/[id] - Get single key
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    return NextResponse.json({ key });
  } catch (error) {
    console.log("Error fetching key:", error);
    return NextResponse.json({ error: "Failed to fetch key" }, { status: 500 });
  }
}

// PUT /api/keys/[id] - Update key
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Body must be a JSON object" }, { status: 400 });
    }
    const { isActive, limitHold } = body;

    const existing = await getApiKeyById(id);
    if (!existing) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    if (isActive !== undefined && typeof isActive !== "boolean") {
      return NextResponse.json({ error: "isActive must be true or false" }, { status: 400 });
    }
    const limits = parseKeyLimitsInput(body);
    if (limits.errors.length) {
      return NextResponse.json({ error: limits.errors.join("; "), errors: limits.errors }, { status: 400 });
    }

    const updateData = { ...limits.data };
    if (isActive !== undefined) updateData.isActive = isActive;
    // null is meaningful here: it clears the override so the key follows the
    // global limit-hold setting again.
    if (limitHold !== undefined) updateData.limitHold = limitHold === null ? null : !!limitHold;

    // Records the dashboard as the one that turned the key off or set its
    // expiry, in the same transaction, so a management key can't undo it.
    const { key: updated } = await updateApiKeyAs(id, updateData, "dashboard");

    return NextResponse.json({ key: updated });
  } catch (error) {
    console.log("Error updating key:", error);
    return NextResponse.json({ error: "Failed to update key" }, { status: 500 });
  }
}

// DELETE /api/keys/[id] - Delete API key
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;

    const deleted = await deleteApiKey(id);
    if (!deleted) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    return NextResponse.json({ message: "Key deleted successfully" });
  } catch (error) {
    console.log("Error deleting key:", error);
    return NextResponse.json({ error: "Failed to delete key" }, { status: 500 });
  }
}
