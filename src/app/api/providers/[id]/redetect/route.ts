import { NextResponse } from "next/server";
import { makeProbeFetch } from "@/lib/probeFetch.js";
import { detectEndpoint, normalizeUrl, outdatedModels } from "@/lib/endpointDetect.js";
import type { DetectProgress, DetectResult, Protocol } from "@/lib/endpointDetect.js";
import { getEndpointCatalog } from "@/lib/endpointCatalog.js";
import { retryAsClient } from "@/lib/endpointImpersonate.js";
import { addCustomModel, deleteCustomModel, getCustomModels, getProviderConnections, getProviderNodeById, updateProviderConnection, updateProviderNode } from "@/lib/localDb";
import { mergeConnectionData, mergeQuirks } from "@/shared/utils/nodeQuirkMerge.js";
import { isCustomEndpoint } from "@/lib/endpointRequestLog.js";
import { guardTarget, respond } from "@/app/api/provider-nodes/detect/ndjson.js";
import { redetectDiff, savedProtocol, savedSettingsFetch } from "./diff.js";
import type { RedetectDiff, RedetectPart, SavedEndpoint } from "./diff.js";

export const dynamic = "force-dynamic";

type Connection = { id: string; isActive?: boolean; apiKey?: string; providerSpecificData?: { ownBaseUrl?: boolean; baseUrl?: string } };
type Candidate = { apiKey: string; url: string; own: boolean };
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,160}$/;
// How many active keys the re-detect check will try before it gives up: enough
// to skip a few dead-but-still-on keys without probing a whole large pool.
const MAX_KEY_ATTEMPTS = 5;

// A diff from a key on its own URL, cut to what holds for the whole endpoint.
function scopeToKey(diff: RedetectDiff): RedetectDiff {
  const { modelRoutes: _routes, ...quirks } = diff.quirks;
  const changes = (diff.protocol ? 1 : 0) + diff.addModels.length + diff.outdatedModels.length + Object.keys(quirks).length;
  return { ...diff, baseUrl: null, removeModels: [], quirks, changes };
}
type CustomModel = { id?: string; providerAlias?: string; type?: string; kind?: string };

// POST /api/providers/[id]/redetect - the endpoint page's "Re-detect": run the
// same free-probe detection as "Add endpoint", trying the active keys in turn
// (each at its own URL if it has one) until one isn't rejected, and answer with
// what would change. Nothing is saved here; the page applies the changes the
// user accepts through the usual routes.
// [id] is the endpoint's node id. Streams progress as NDJSON when asked.
// ?part=endpoint checks the API, URL and fixes without asking about models;
// ?part=models reports only models (it still finds which APIs answer, to ask each).
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
  // Active keys in priority order, the ones on the endpoint's own URL first. A
  // key with its own URL (another account or region of the same API) is asked
  // at that URL. Keys are tried in turn, so neither a dead-but-on key nor a pool
  // where every key has its own URL makes the check probe with no key at all.
  const active = conns.filter((c) => c.isActive !== false);
  const keys = [...active.filter((c) => !c.providerSpecificData?.ownBaseUrl), ...active.filter((c) => c.providerSpecificData?.ownBaseUrl)];
  const candidates: Candidate[] = [];
  for (const c of keys) {
    if (candidates.length >= MAX_KEY_ATTEMPTS) break;
    if (!c.providerSpecificData?.ownBaseUrl) { candidates.push({ apiKey: c.apiKey || "", url: base, own: false }); continue; }
    const url = normalizeUrl(c.providerSpecificData.baseUrl);
    if (!url) continue;
    if ((await guardTarget(request, url)) instanceof NextResponse) continue;
    candidates.push({ apiKey: c.apiKey || "", url, own: true });
  }
  if (!candidates.length) candidates.push({ apiKey: "", url: base, own: false });
  const current = ((await getCustomModels()) as CustomModel[])
    .filter((m) => m.providerAlias === id && (m.kind || m.type || "llm") === "llm" && m.id)
    .map((m) => m.id as string);
  const rawFetch = makeProbeFetch(guard.remote);
  const q = new URL(request.url).searchParams.get("part");
  const part: RedetectPart = q === "endpoint" || q === "models" ? q : "all";
  const skipModels = part === "endpoint";
  return respond(request, "re-detecting endpoint", async (signal, send) => {
    const catalog = await getEndpointCatalog();
    // As in the detect route: each extra run (the client-identity retry, and
    // each fall-through to the next key) restarts its request numbers at 1, so
    // shift them past every run before it.
    let maxN = 0, offset = 0, sentBase = 0, maxSent = 0;
    const onProgress = (e: DetectProgress) => {
      const ev = { ...e } as DetectProgress & { n?: number; sent?: number };
      if (typeof ev.n === "number") { ev.n += offset; maxN = Math.max(maxN, ev.n); }
      if (typeof ev.sent === "number") { ev.sent += sentBase; maxSent = Math.max(maxSent, ev.sent); }
      send(ev);
    };
    const runWith = async ({ apiKey: key, url }: Candidate): Promise<DetectResult & { gate?: unknown }> => {
      offset = maxN; sentBase = maxSent;
      // Probe with the endpoint's saved identity and auth style, as requests go out.
      const first = await detectEndpoint({ url, apiKey: key, fetchFn: savedSettingsFetch(rawFetch, node, key), catalog, signal, onProgress, skipModels });
      // Still client-gated (no saved identity, or it stopped working): try the
      // known clients, as Add endpoint does. Their headers replace the saved ones.
      return retryAsClient(first, {
        url, apiKey: key, fetchFn: savedSettingsFetch(rawFetch, node, key, { identity: false }), signal,
        detect: (f) => { offset = maxN; sentBase = maxSent; return detectEndpoint({ url, apiKey: key, fetchFn: f, catalog, signal, onProgress, skipModels }); },
      });
    };
    let used = candidates[0];
    let result = await runWith(used);
    // Only a rejected key earns another try: a network/down/gated/rate result is
    // the endpoint's verdict, not the key's, and the next key would only repeat
    // it (and spend more free probes). A key on its own URL is another server,
    // so its refusal or outage says nothing about the next one: try it too.
    for (let i = 1; i < candidates.length && !signal.aborted && !result.ok && (result.failure === "key" || used.own); i++) {
      used = candidates[i];
      result = await runWith(used);
    }
    const diff = redetectDiff(node, current, result, outdatedModels(current, catalog), part);
    // What a key on its own URL sees is that account's: never offer it as the
    // endpoint's URL, or let it drop models or rewrite routes for the other keys.
    const scoped = used.own && diff.ok ? scopeToKey(diff) : diff;
    return { ...scoped, steps: result.steps, protocols: result.protocols || [], models: result.models || [], usedKey: !!used.apiKey, ...(used.own ? { viaKeyUrl: true } : {}), ...(result.gate ? { gate: result.gate } : {}) };
  }, { ok: false, error: "Re-detect failed", steps: [] });
}

// The API the node answers on after this PUT.
const finalProtocol = (node: { type?: string; apiType?: string }, apiType: unknown): Protocol =>
  savedProtocol({ type: node.type, apiType: typeof apiType === "string" ? apiType : node.apiType });

// Re-detect offers modelRoutes as a full model -> API map; stored routes list
// only the models that leave the node's own API, so drop the rest. Done
// before sanitizing so its route cap counts only real routes.
function ownRoutesOnly(quirks: unknown, own: Protocol): unknown {
  if (!quirks || typeof quirks !== "object" || Array.isArray(quirks)) return quirks;
  const q = quirks as { modelRoutes?: unknown };
  if (!q.modelRoutes || typeof q.modelRoutes !== "object" || Array.isArray(q.modelRoutes)) return quirks;
  return { ...q, modelRoutes: Object.fromEntries(Object.entries(q.modelRoutes as Record<string, unknown>).filter(([, p]) => p !== own)) };
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
  // Switching API without a route offer (Re-detect's endpoint half): models
  // that rode the old API implicitly keep it, as explicit routes.
  let offered = body.quirks;
  const oldProto = savedProtocol({ type: node.type, apiType: node.apiType });
  const hasRoutes = !!offered && typeof offered === "object" && "modelRoutes" in (offered as object);
  if (updates.apiType !== undefined && finalProtocol(node, updates.apiType) !== oldProto && !hasRoutes) {
    const saved = (node.modelRoutes || {}) as Record<string, string>;
    const mine = ((await getCustomModels()) as CustomModel[]).filter((m) => m.providerAlias === id && (m.kind || m.type || "llm") === "llm" && m.id).map((m) => m.id as string);
    offered = { ...(offered && typeof offered === "object" ? offered : {}), modelRoutes: Object.fromEntries(mine.map((m) => [m, saved[m] || oldProto])) };
  }
  const { quirks, removed } = mergeQuirks(node, { quirks: ownRoutesOnly(offered, finalProtocol(node, updates.apiType)) });
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
  const gone = ids(body.removeModels);
  for (const m of gone) {
    try { await deleteCustomModel({ providerAlias: id, id: m, type: "llm" }); } catch { failed++; }
  }
  // Removed models' routes would keep their API's badge on the endpoint card.
  let node2 = updated;
  const routes = (updated.modelRoutes || {}) as Record<string, string>;
  if (gone.some((m) => m in routes)) {
    const modelRoutes = Object.fromEntries(Object.entries(routes).filter(([m]) => !gone.includes(m)));
    node2 = (await updateProviderNode(id, { modelRoutes })) || { ...updated, modelRoutes };
  }
  return NextResponse.json({ node: node2, added, failed });
}
