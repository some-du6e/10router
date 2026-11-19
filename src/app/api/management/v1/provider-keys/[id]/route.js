import { getProviderKey, removeProviderKey } from "@/lib/management/handlers.js";

export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  const { id } = await params;
  return getProviderKey(request, id);
}

export async function DELETE(request, { params }) {
  const { id } = await params;
  return removeProviderKey(request, id);
}
