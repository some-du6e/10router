import { NextResponse } from "next/server";
import { makeProbeFetch } from "@/lib/probeFetch.js";
import { detectEndpoint, normalizeUrl } from "@/lib/endpointDetect.js";
import type { DetectProgress, DetectResult } from "@/lib/endpointDetect.js";
import { getEndpointCatalog } from "@/lib/endpointCatalog.js";
import { addCustomModel, deleteCustomModel, getCustomModels, getProviderConnections, getProviderNodeById, updateProviderConnection, updateProviderNode } from "@/lib/localDb";
import { mergeConnectionData, mergeQuirks } from "@/shared/utils/nodeQuirkMerge.js";
import { isCustomEndpoint } from "@/lib/endpointRequestLog.js";
import { guardTarget, respond } from "@/app/api/provider-nodes/detect/ndjson.js";
import { redetectDiff } from "./diff.js";
import type { SavedEndpoint } from "./diff.js";

export const dynamic = "force-dynamic";

type Connection = { id: string; isActive?: boolean; apiKey?: string; providerSpecificData?: { ownBaseUrl?: boolean } };
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,160}$/;
type CustomModel = { id?: string; providerAlias?: string; type?: string; kind?: string };

// POST /api/providers/[id]/redetect - the endpoint page's "Re-detect": run the
// same free-probe detection as "Add endpoint" on the saved URL with the first
// active key, and answer with what would change. Nothing is saved here; the
// page applies the changes the user accepts through the usual routes.
// [id] is the endpoint's node id. Streams progress as NDJSON when asked.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isCustomEndpoint(id)) return NextResponse.json({ ok: false, error: "Not a custom endpoint" }, { status: 400 });
  const node = (await getProviderNodeById(id)) as (SavedEndpoint & { baseUrl?: string }) | null;
  if (!node) return NextResponse.json({ ok: false, error: "Endpoint not found" }, { status: 404 });
  const base = normalizeUrl(node.baseUrl);
  if (!base) return NextResponse.json({ ok: false, error: "The saved URL isn't valid" }, { status: 400 });
  const guard = await guardTarget(request, base);
  if (guard instanceof NextResponse) return guard;

  const conns = (await getProviderConnections({ provider: id })) as Connection[];
  const conn = conns.find((c) => c.isActive !== false && !c.providerSpecificData?.ownBaseUrl) || null;
  const current = ((await getCustomModels()) as CustomModel[])
    .filter((m) => m.providerAlias === id && (m.kind || m.type || "llm") === "llm" && m.id)
    .map((m) => m.id as string);
  const fetchFn = makeProbeFetch(guard.remote);
  return respond(request, "re-detecting endpoint", async (signal, send) => {
    const result: DetectResult = await detectEndpoint({ url: base, apiKey: conn?.apiKey || "", fetchFn, catalog: await getEndpointCatalog(), signal, onProgress: (e: DetectProgress) => send(e) });
    return { ...redetectDiff(node, current, result), steps: result.steps, protocols: result.protocols || [], models: result.models || [], usedKey: !!conn };
  }, { ok: false, error: "Re-detect failed", steps: [] });
}

// PUT /api/providers/[id]/redetect - apply what the user accepted from a
// re-detect. Body: { baseUrl?, apiType?: "chat" | "responses", quirks?,
// addModels?: string[], removeModels?: string[], modelsNote? }. The node and
// every key move together, like the node PUT (learned beta flags survive).
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isCustomEndpoint(id)) return NextResponse.json({ error: "Not a custom endpoint" }, { status: 400 });
  const node = (await getProviderNodeById(id)) as (Record<string, unknown> & { type?: string; baseUrl?: string; apiType?: string; droppedBetas?: string[] }) | null;
  if (!node) return NextResponse.json({ error: "Endpoint not found" }, { status: 404 });
  let body: { baseUrl?: unknown; apiType?: unknown; quirks?: unknown; addModels?: unknown; removeModels?: unknown; modelsNote?: unknown } = {};
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Bad request" }, { status: 400 }); }

  const updates: Record<string, unknown> = {};
  if (body.baseUrl !== undefined) {
    const base = normalizeUrl(body.baseUrl);
    if (!base) return NextResponse.json({ error: "That doesn't look like a URL." }, { status: 400 });
    const guard = await guardTarget(request, base);
    if (guard instanceof NextResponse) return guard;
    updates.baseUrl = base;
  }
  if (body.apiType !== undefined) {
    if (node.type !== "openai-compatible" || (body.apiType !== "chat" && body.apiType !== "responses")) return NextResponse.json({ error: "Can't change the API type of this endpoint" }, { status: 400 });
    updates.apiType = body.apiType;
  }
  if (typeof body.modelsNote === "string") updates.modelsNote = body.modelsNote.slice(0, 200);
  const { quirks, removed } = mergeQuirks(node, { quirks: body.quirks });
  Object.assign(updates, quirks);
  const updated = (await updateProviderNode(id, updates)) as unknown as Record<string, unknown> & { baseUrl?: string; apiType?: string; prefix?: string; name?: string };

  const conns = (await getProviderConnections({ provider: id })) as (Connection & { providerSpecificData?: Record<string, unknown> })[];
  await Promise.all(conns.map((c) => updateProviderConnection(c.id, {
    providerSpecificData: mergeConnectionData(c.providerSpecificData || {}, updated, {
      removed,
      connectionFields: {
        ...(node.type === "openai-compatible" ? { apiType: updated.apiType } : {}),
        baseUrl: c.providerSpecificData?.ownBaseUrl ? c.providerSpecificData.baseUrl : updated.baseUrl,
      },
    }),
  })));

  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && MODEL_RE.test(x)).slice(0, 1000) : []);
  let added = 0, failed = 0;
  for (const m of ids(body.addModels)) {
    try { await addCustomModel({ providerAlias: id, id: m, type: "llm", name: undefined, caps: undefined }); added++; } catch { failed++; }
  }
  for (const m of ids(body.removeModels)) {
    try { await deleteCustomModel({ providerAlias: id, id: m, type: "llm" }); } catch { failed++; }
  }
  return NextResponse.json({ node: updated, added, failed });
}
