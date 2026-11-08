import { getClientKey, updateClientKey, removeClientKey } from "@/lib/management/handlers.js";

export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  const { id } = await params;
  return getClientKey(request, id);
}

export async function PATCH(request, { params }) {
  const { id } = await params;
  return updateClientKey(request, id);
}

export async function DELETE(request, { params }) {
  const { id } = await params;
  return removeClientKey(request, id);
}
