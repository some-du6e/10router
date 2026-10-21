import { NextResponse } from "next/server";
import { makeProbeFetch } from "@/lib/probeFetch.js";
import { discardBody, fetchSiteInfo, imageSize, normalizeUrl, readCapped } from "@/lib/endpointDetect.js";
import type { SiteFetch } from "@/lib/endpointDetect.js";
import { getProviderNodeById, updateProviderNode } from "@/lib/localDb";
import { isCustomEndpoint } from "@/lib/endpointRequestLog.js";

export const dynamic = "force-dynamic";

const ICON_MAX_BYTES = 256 * 1024;
const STORED_ICON_MAX_CHARS = 96 * 1024;
const ICON_MIN_PX = 32;
type Ctx = { params: Promise<{ id: string }> };

// Image type from the first bytes; null when it isn't one we show.
function sniffImage(b: Uint8Array): string | null {
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0 && b[1] === 0 && b[2] === 1) return "image/x-icon";
  if (b[0] === 0x47 && b[1] === 0x49) return "image/gif";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return "image/webp";
  return null;
}

// GET /api/providers/[id]/redetect/icon - the provider's own site icon (and
// name), re-fetched for the icon picker's "From site". No key is sent; the site
// is always a public host, so it's SSRF-guarded for every caller.
export async function GET(_request: Request, { params }: Ctx) {
  const { id } = await params;
  if (!isCustomEndpoint(id)) return NextResponse.json({ error: "Not a custom endpoint" }, { status: 400 });
  const node = (await getProviderNodeById(id)) as { baseUrl?: string } | null;
  const base = normalizeUrl(node?.baseUrl);
  if (!base) return NextResponse.json({ site: null });
  const site = await fetchSiteInfo(base, makeProbeFetch(true) as unknown as SiteFetch).catch(() => null);
  return NextResponse.json({ site });
}

// POST /api/providers/[id]/redetect/icon - "Or paste an image URL": fetch it
// once (public hosts only, no key), check it's a real image under 256 KB and
// at least 32px, and answer with a data: URL copy. The page stores the copy on
// the node, so the dashboard never hotlinks.
export async function POST(request: Request, { params }: Ctx) {
  const { id } = await params;
  if (!isCustomEndpoint(id)) return NextResponse.json({ error: "Not a custom endpoint" }, { status: 400 });
  let body: { url?: unknown } = {};
  try { body = await request.json(); } catch { /* handled below */ }
  let url: URL;
  try { url = new URL(String(body.url || "")); } catch { return NextResponse.json({ error: "That isn't a URL" }, { status: 400 }); }
  if (url.protocol !== "https:" && url.protocol !== "http:") return NextResponse.json({ error: "That isn't a URL" }, { status: 400 });
  try {
    const res = await makeProbeFetch(true)(url.toString(), { method: "GET", headers: { accept: "image/*" }, signal: AbortSignal.timeout(6000) });
    if (!res.ok) { discardBody(res); return NextResponse.json({ error: `The image answered ${res.status}` }, { status: 400 }); }
    if (Number(res.headers.get("content-length") || 0) > ICON_MAX_BYTES) { discardBody(res); return NextResponse.json({ error: "Images up to 256 KB" }, { status: 400 }); }
    const { bytes, over } = await readCapped(res, ICON_MAX_BYTES);
    if (!bytes.length || over) return NextResponse.json({ error: "Images up to 256 KB" }, { status: 400 });
    const ct = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    // SVG can carry script; only raster formats are accepted from a URL.
    const type = sniffImage(bytes);
    if (!type || ct === "image/svg+xml") return NextResponse.json({ error: "That isn't a PNG, JPEG, GIF, WebP or ICO image" }, { status: 400 });
    const px = imageSize(bytes);
    if (px !== null && px < ICON_MIN_PX) return NextResponse.json({ error: "Too small: at least 32px" }, { status: 400 });
    return NextResponse.json({ icon: `data:${type};base64,${Buffer.from(bytes).toString("base64")}` });
  } catch {
    return NextResponse.json({ error: "Couldn't fetch that image" }, { status: 400 });
  }
}

const DATA_URL_RE = /^data:image\/(png|jpeg|gif|webp|x-icon|svg\+xml);base64,[A-Za-z0-9+/=]+$/;
const TINT_RE = /^#[0-9a-f]{6}$/i;

// PUT /api/providers/[id]/redetect/icon - save the endpoint's icon on its node.
// Body: { icon: data: URL | null (letter tile), siteIcon?: data: URL | null, tint?: "#rrggbb" | null }.
// Only data: URL copies are stored (from the site, an upload, or POST above).
export async function PUT(request: Request, { params }: Ctx) {
  const { id } = await params;
  if (!isCustomEndpoint(id)) return NextResponse.json({ error: "Not a custom endpoint" }, { status: 400 });
  const node = await getProviderNodeById(id);
  if (!node) return NextResponse.json({ error: "Endpoint not found" }, { status: 404 });
  let body: { icon?: unknown; siteIcon?: unknown; tint?: unknown } = {};
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Bad request" }, { status: 400 }); }
  // The dashboard shrinks icons to 128px first; they sit on the node, which routing reads per request.
  const img = (v: unknown) => v === null || (typeof v === "string" && v.length <= STORED_ICON_MAX_CHARS && DATA_URL_RE.test(v));
  const updates: Record<string, unknown> = {};
  if ("icon" in body) { if (!img(body.icon)) return NextResponse.json({ error: "Icon too large to store; try a smaller image" }, { status: 400 }); updates.icon = body.icon; }
  if ("siteIcon" in body) { if (!img(body.siteIcon)) return NextResponse.json({ error: "Bad site icon" }, { status: 400 }); updates.siteIcon = body.siteIcon; }
  if ("tint" in body) { if (body.tint !== null && !(typeof body.tint === "string" && TINT_RE.test(body.tint))) return NextResponse.json({ error: "Bad colour" }, { status: 400 }); updates.tint = body.tint; }
  const updated = await updateProviderNode(id, updates);
  return NextResponse.json({ node: updated });
}
