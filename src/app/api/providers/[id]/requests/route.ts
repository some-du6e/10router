import { NextResponse } from "next/server";
import { getApiKeys, getCustomModels, getProviderNodeById } from "@/lib/localDb";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { UPDATER_CONFIG } from "@/shared/constants/config";
import { clearEndpointRequests, errorMessage, getEndpointRequests, isCustomEndpoint, outputTokens, replyText } from "@/lib/endpointRequestLog.js";
import { pickTestModel } from "./pick.js";

export const dynamic = "force-dynamic";

const CLI_TOKEN_SALT = "9r-cli-auth";
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,160}$/;
type CustomModel = { id?: string; providerAlias?: string; type?: string; kind?: string };
type Ctx = { params: Promise<{ id: string }> };

// GET /api/providers/[id]/requests - "Recent requests" for a custom endpoint:
// the last upstream requests the router sent it (src/lib/endpointRequestLog.ts).
export async function GET(_request: Request, { params }: Ctx) {
  const { id } = await params;
  if (!isCustomEndpoint(id)) return NextResponse.json({ error: "Not a custom endpoint" }, { status: 400 });
  return NextResponse.json({ requests: getEndpointRequests(id) });
}

// DELETE /api/providers/[id]/requests - clear that list.
export async function DELETE(_request: Request, { params }: Ctx) {
  const { id } = await params;
  if (!isCustomEndpoint(id)) return NextResponse.json({ error: "Not a custom endpoint" }, { status: 400 });
  clearEndpointRequests(id);
  return NextResponse.json({ ok: true });
}

// POST /api/providers/[id]/requests - "Send test message": ONE real "hi" with a
// 1-token cap, sent through the router itself (so every fix, retry and key
// rotation applies, and it lands in Recent requests). Body: { model? }; without
// one it picks the endpoint's cheapest-looking model. May cost a few tokens,
// which is why it only runs when the user clicks.
export async function POST(request: Request, { params }: Ctx) {
  const { id } = await params;
  if (!isCustomEndpoint(id)) return NextResponse.json({ ok: false, error: "Not a custom endpoint" }, { status: 400 });
  const node = (await getProviderNodeById(id)) as { type?: string } | null;
  if (!node) return NextResponse.json({ ok: false, error: "Endpoint not found" }, { status: 404 });
  let body: { model?: unknown } = {};
  try { body = await request.json(); } catch { /* no body: pick a model */ }
  const models = ((await getCustomModels()) as CustomModel[])
    .filter((m) => m.providerAlias === id && (m.kind || m.type || "llm") === "llm" && m.id)
    .map((m) => m.id as string);
  const model = typeof body.model === "string" && body.model ? body.model : pickTestModel(models);
  if (!model || !MODEL_RE.test(model)) return NextResponse.json({ ok: false, error: "This endpoint has no models yet. Add one first." }, { status: 400 });

  const anthropic = node.type === "anthropic-compatible";
  const headers: Record<string, string> = { "Content-Type": "application/json", "x-9r-cli-token": await (getConsistentMachineId as unknown as (salt: string) => Promise<string>)(CLI_TOKEN_SALT) };
  try {
    const keys = (await getApiKeys()) as { key?: string; isActive?: boolean }[];
    const k = keys.find((x) => x.isActive !== false)?.key;
    if (k) headers.Authorization = `Bearer ${k}`;
  } catch { /* no client keys: local mode */ }
  if (anthropic) headers["anthropic-version"] = "2023-06-01";
  const port = process.env.PORT || new URL(request.url).port || UPDATER_CONFIG.appPort;
  const url = `http://127.0.0.1:${port}/api/v1/${anthropic ? "messages" : "chat/completions"}`;
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: `${id}/${model}`, max_tokens: 1, stream: false, messages: [{ role: "user", content: "hi" }] }),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]),
    });
    const text = await res.text().catch(() => "");
    return NextResponse.json({
      ok: res.ok, status: res.status, model, ms: Date.now() - start,
      reply: res.ok ? replyText(text) : "", tokens: res.ok ? outputTokens(text) : null,
      error: res.ok ? null : errorMessage(text) || `HTTP ${res.status}`,
      requests: getEndpointRequests(id),
    });
  } catch (error) {
    return NextResponse.json({ ok: false, status: 0, model, error: (error as Error).message || "No answer", requests: getEndpointRequests(id) });
  }
}
