import { NextResponse } from "next/server";
import { makeProbeFetch } from "@/lib/probeFetch.js";
import { DETECT_DEADLINE_MS, detectEndpoint, normalizeUrl, outdatedModels } from "@/lib/endpointDetect.js";
import type { DetectProgress, DetectResult, Protocol } from "@/lib/endpointDetect.js";
import { getEndpointCatalog } from "@/lib/endpointCatalog.js";
import { retryAsClient } from "@/lib/endpointImpersonate.js";
import { addCustomModel, deleteCustomModel, getCustomModels, getProviderConnections, getProviderNodeById, updateProviderConnection, updateProviderNode } from "@/lib/localDb";
import { mergeConnectionData, mergeQuirks } from "@/shared/utils/nodeQuirkMerge.js";
import { isCustomEndpoint } from "@/lib/endpointRequestLog.js";
import { guardTarget, respond } from "@/app/api/provider-nodes/detect/ndjson.js";
import { redetectDiff, savedProtocol, savedSettingsFetch } from "./diff.js";
import type { RedetectPart, SavedEndpoint } from "./diff.js";

export const dynamic = "force-dynamic";

type Connection = { id: string; isActive?: boolean; apiKey?: string; providerSpecificData?: { ownBaseUrl?: boolean; baseUrl?: string } };
type Candidate = { apiKey: string; url: string; own: boolean };
type Run = { candidate: Candidate; result: DetectResult & { gate?: unknown } };
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,160}$/;
// How many active keys the re-detect check will try before it gives up: enough
// to skip a few dead-but-still-on keys without probing a whole large pool.
const MAX_KEY_ATTEMPTS = 5;
// Every key tried shares one detection's time budget (the page gives up at
// 60s); another key isn't started with less than this left.
const MIN_ATTEMPT_MS = 5_000;
type CustomModel = { id?: string; providerAlias?: string; type?: string; kind?: string };

// Detection says what each run showed about its key (see KeyVerdict). Rate
// limits and quota are usually per key, as inference's failover assumes.
const keyRefused = (r: DetectResult) => r.keyVerdict === "refused";
const rateLimited = (r: DetectResult) => r.keyVerdict === "rate-limited";
const worked = (r: DetectResult) => r.ok && r.keyVerdict === "accepted";
const clause = (s: string | undefined) => String(s || "").replace(/\s*\.*\s*$/, "");

// POST /api/providers/[id]/redetect - the endpoint page's "Re-detect": run the
// same free-probe detection as "Add endpoint", trying the active keys in turn
// (each at its own URL if it has one) until one works, and answer with what
// would change. Nothing is saved here; the page applies the changes the user
// accepts through the usual routes.
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
  // Active keys with a credential, in priority order, the ones on the
  // endpoint's own URL first. A key with its own URL (another account or region
  // of the same API) is asked at that URL; the probe fetch checks every hop
  // against the SSRF rules for remote callers, as it does the endpoint's URL.
  const active = conns.filter((c) => c.isActive !== false && c.apiKey);
  const all: Candidate[] = active.flatMap((c): Candidate[] => {
    const url = c.providerSpecificData?.ownBaseUrl ? normalizeUrl(c.providerSpecificData?.baseUrl) : base;
    // A key still flagged with its own URL after the endpoint moved to that URL
    // is on the endpoint's URL.
    return url ? [{ apiKey: c.apiKey as string, url, own: url !== base }] : [];
  });
  const candidates = [...all.filter((c) => !c.own), ...all.filter((c) => c.own)].slice(0, MAX_KEY_ATTEMPTS);
  // Keys exist but none has a usable URL: say that, rather than probing with no
  // key and blaming a key.
  if (active.length && !candidates.length) return NextResponse.json({ ok: false, error: "None of the active keys has a valid URL of its own", steps: [] }, { status: 400 });
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
    const deadlineAt = Date.now() + DETECT_DEADLINE_MS;
    const left = () => Math.max(0, deadlineAt - Date.now());
    const onProgress = (e: DetectProgress) => {
      const ev = { ...e } as DetectProgress & { n?: number; sent?: number };
      if (typeof ev.n === "number") { ev.n += offset; maxN = Math.max(maxN, ev.n); }
      if (typeof ev.sent === "number") { ev.sent += sentBase; maxSent = Math.max(maxSent, ev.sent); }
      send(ev);
    };
    const runWith = async ({ apiKey: key, url }: Candidate): Promise<Run["result"]> => {
      offset = maxN; sentBase = maxSent;
      // Probe with the endpoint's saved identity and auth style, as requests go out.
      const first = await detectEndpoint({ url, apiKey: key, fetchFn: savedSettingsFetch(rawFetch, node, key), catalog, signal, onProgress, skipModels, deadlineMs: left() });
      // Still client-gated (no saved identity, or it stopped working): try the
      // known clients, as Add endpoint does. Their headers replace the saved ones.
      return retryAsClient(first, {
        url, apiKey: key, fetchFn: savedSettingsFetch(rawFetch, node, key, { identity: false }), signal,
        detect: (f) => { offset = maxN; sentBase = maxSent; return detectEndpoint({ url, apiKey: key, fetchFn: f, catalog, signal, onProgress, skipModels, deadlineMs: left() }); },
      });
    };
    // The next key gets a try after a refusal or a rate limit. After anything
    // else (down, gated) only when this key had its own URL: a key on the
    // endpoint's URL would just meet the same server, while another account's
    // server may be fine.
    const runs: Run[] = [];
    for (const candidate of candidates) {
      if (runs.length && (signal.aborted || left() < MIN_ATTEMPT_MS)) break;
      const result = await runWith(candidate);
      runs.push({ candidate, result });
      if (worked(result) || (!keyRefused(result) && !rateLimited(result) && !candidate.own)) break;
    }
    const last = runs[runs.length - 1];
    const win = worked(last.result) ? last : null;
    // None worked: report the first key's verdict (the endpoint's own URL when
    // a key uses it), as a failure even when its refusal came after the free
    // probes passed, and say how many keys were tried. A run with no key keeps
    // its result, a refusal reworded as needing a key: there is no key to blame.
    const shown = win || runs[0];
    const refused = keyRefused(shown.result);
    const verdict = clause(shown.result.error) || (refused ? "The key was rejected" : clause(shown.result.partialReason || undefined) || "No answer");
    if (!shown.candidate.apiKey && !shown.result.ok && shown.result.failure === "key") {
      const on = conns.some((c) => c.isActive !== false);
      shown.result = { ...shown.result, error: on ? "It needs a key, and no switched-on key has one set" : conns.length ? "It needs a key, and none of its keys is switched on" : "It needs a key, and this endpoint has none" };
    }
    const result = win || (runs.length === 1 && (!shown.result.ok || !shown.candidate.apiKey)) ? shown.result : {
      ...shown.result, ok: false as const,
      error: runs.length === 1 ? verdict
        : runs.every((r) => keyRefused(r.result)) ? `None of the ${runs.length} keys it tried was accepted`
        : `None of the ${runs.length} keys it tried worked. The first: ${verdict}`,
    };
    // What a key on its own URL sees is that account's: redetectDiff keeps its
    // URL, missing models, routes and auth style out of the endpoint's changes.
    const via = shown.candidate.own;
    const diff = redetectDiff(node, current, result, outdatedModels(current, catalog), part, { keyScoped: via });
    return { ...diff, steps: result.steps, protocols: result.protocols || [], models: result.models || [], usedKey: !!shown.candidate.apiKey, ...(via ? { viaKeyUrl: true } : {}), ...(result.gate ? { gate: result.gate } : {}) };
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
