import { NextResponse } from "next/server";
import REGISTRY from "open-sse/providers/registry/index.js";
import { fetchPublic } from "@/shared/utils/ssrfGuard.js";
import { FILTERS } from "./filters.js";

const KNOWN_FETCHERS = new Set(
  REGISTRY.filter((entry) => entry.modelsFetcher?.url).map((entry) => `${entry.modelsFetcher.type} ${entry.modelsFetcher.url}`),
);

export const dynamic = "force-dynamic";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get("url");
  const type = searchParams.get("type");

  if (!url || !type) {
    return NextResponse.json({ error: "Missing url or type" }, { status: 400 });
  }

  const filter = FILTERS[type];
  if (!filter) {
    return NextResponse.json({ error: "Unknown filter type" }, { status: 400 });
  }

  if (!KNOWN_FETCHERS.has(`${type} ${url}`)) {
    return NextResponse.json({ error: "Unknown models URL" }, { status: 400 });
  }

  try {
    const res = await fetchPublic(url);
    if (!res.ok) {
      return NextResponse.json({ data: [] });
    }
    const json = await res.json();
    const raw = json.data ?? json.models ?? json;
    const data = filter(Array.isArray(raw) ? raw : []);
    return NextResponse.json({ data });
  } catch {
    return NextResponse.json({ data: [] });
  }
}
