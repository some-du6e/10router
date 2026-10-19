import { NextResponse } from "next/server";
import { getProviderConnectionById, getProviderNodeById, updateProviderNode, getProviderConnections, updateProviderConnection } from "@/models";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "@/shared/constants/providers";
import { isLocalRequest } from "@/dashboardGuard";
import { assertPublicUrlResolved } from "@/shared/utils/ssrfGuard.js";
import { discoverModels } from "@/lib/endpointDetect.js";
import { getEndpointCatalog } from "@/lib/endpointCatalog.js";
import { makeProbeFetch } from "@/lib/probeFetch.js";

export const dynamic = "force-dynamic";

// Routes are relative to the node's own path: drop entries that point back at it.
async function saveRoutes(nodeId, ownProtocol, routes) {
  const modelRoutes = Object.fromEntries(Object.entries(routes).filter(([, p]) => p !== ownProtocol));
  const node = await getProviderNodeById(nodeId);
  if (!node) return;
  await updateProviderNode(nodeId, { modelRoutes });
  const connections = await getProviderConnections({ provider: nodeId });
  await Promise.all(connections.map((c) => updateProviderConnection(c.id, { providerSpecificData: { ...(c.providerSpecificData || {}), modelRoutes } })));
}

// GET /api/providers/[id]/discover-models - Model ids for a user-added endpoint.
// Uses /models when it exists; otherwise asks about catalog models one at a time
// with empty-body requests (free). Never sends a billed generation.
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);
    if (!connection) return NextResponse.json({ error: "Connection not found" }, { status: 404 });

    const anthropic = isAnthropicCompatibleProvider(connection.provider);
    if (!anthropic && !isOpenAICompatibleProvider(connection.provider)) {
      return NextResponse.json({ error: "Only for custom endpoints" }, { status: 400 });
    }
    const baseUrl = connection.providerSpecificData?.baseUrl;
    if (!baseUrl) return NextResponse.json({ error: "No base URL configured" }, { status: 400 });

    const remote = !isLocalRequest(request);
    if (remote) {
      try { await assertPublicUrlResolved(baseUrl); }
      catch { return NextResponse.json({ error: "URL not allowed" }, { status: 400 }); }
    }

    const protocol = anthropic ? "anthropic" : connection.providerSpecificData?.apiType === "responses" ? "openai-responses" : "openai-chat";
    // Two-path nodes: probe every path this endpoint already routes to.
    const existing = connection.providerSpecificData?.modelRoutes || {};
    const protocols = [...new Set([protocol, ...Object.values(existing)])];
    const result = await discoverModels({
      baseUrl,
      apiKey: connection.apiKey,
      protocol,
      protocols,
      fetchFn: makeProbeFetch(remote),
      catalog: await getEndpointCatalog(),
    });
    if (result.routes) await saveRoutes(connection.provider, protocol, result.routes);
    return NextResponse.json({ models: result.models.map((m) => ({ id: m })), source: result.source, catalogName: result.catalogName, routes: result.routes, steps: result.steps });
  } catch (error) {
    console.log("Error discovering models:", error?.message);
    return NextResponse.json({ error: "Failed to discover models" }, { status: 500 });
  }
}
