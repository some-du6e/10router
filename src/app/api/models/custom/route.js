import { NextResponse } from "next/server";
import { getCustomModels, addCustomModel, deleteCustomModel } from "@/models";
import { CAPACITY_META } from "@/shared/constants/models";

export const dynamic = "force-dynamic";

// Whitelist capability keys to boolean values — ignore anything else
function sanitizeCaps(caps) {
  if (!caps || typeof caps !== "object") return null;
  const clean = {};
  for (const key of Object.keys(CAPACITY_META)) {
    if (typeof caps[key] === "boolean") clean[key] = caps[key];
  }
  return Object.keys(clean).length ? clean : null;
}

// GET /api/models/custom - List all custom models
export async function GET() {
  try {
    const models = await getCustomModels();
    return NextResponse.json({ models });
  } catch (error) {
    console.log("Error fetching custom models:", error);
    return NextResponse.json({ error: "Failed to fetch custom models" }, { status: 500 });
  }
}

const MAX_BULK = 1000;

// POST /api/models/custom - Add a custom model, or many at once:
//   { providerAlias, id, type?, name?, caps? }
//   { providerAlias, type?, models: ["id", { id, name?, caps? }, ...] }
// The bulk form reports per-model failures instead of stopping at the first one.
export async function POST(request) {
  try {
    const body = await request.json();
    const { providerAlias, type } = body;
    if (Array.isArray(body.models)) {
      if (!providerAlias) return NextResponse.json({ error: "providerAlias required" }, { status: 400 });
      if (body.models.length > MAX_BULK) return NextResponse.json({ error: `At most ${MAX_BULK} models at once` }, { status: 400 });
      const added = [];
      const failed = [];
      for (const m of body.models) {
        const entry = typeof m === "string" ? { id: m } : (m && typeof m === "object" ? m : {});
        const id = typeof entry.id === "string" ? entry.id.trim() : "";
        if (!id) { failed.push({ id: entry.id ?? null, error: "id required" }); continue; }
        try {
          const cleanCaps = sanitizeCaps(entry.caps);
          await addCustomModel({ providerAlias, id, type: type || "llm", name: entry.name, ...(cleanCaps ? { caps: cleanCaps } : {}) });
          added.push(id);
        } catch (error) {
          console.log("Error adding custom model:", error);
          failed.push({ id, error: "Failed to save" });
        }
      }
      return NextResponse.json({ success: failed.length === 0, added, failed }, { status: added.length || !failed.length ? 200 : 500 });
    }

    const { id, name, caps } = body;
    if (!providerAlias || !id) {
      return NextResponse.json({ error: "providerAlias and id required" }, { status: 400 });
    }
    const cleanCaps = sanitizeCaps(caps);
    const added = await addCustomModel({ providerAlias, id, type: type || "llm", name, ...(cleanCaps ? { caps: cleanCaps } : {}) });
    return NextResponse.json({ success: true, added });
  } catch (error) {
    console.log("Error adding custom model:", error);
    return NextResponse.json({ error: "Failed to add custom model" }, { status: 500 });
  }
}

// DELETE /api/models/custom?providerAlias=xxx&id=yyy&type=zzz
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const providerAlias = searchParams.get("providerAlias");
    const id = searchParams.get("id");
    const type = searchParams.get("type") || "llm";
    if (!providerAlias || !id) {
      return NextResponse.json({ error: "providerAlias and id required" }, { status: 400 });
    }
    await deleteCustomModel({ providerAlias, id, type });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting custom model:", error);
    return NextResponse.json({ error: "Failed to delete custom model" }, { status: 500 });
  }
}
