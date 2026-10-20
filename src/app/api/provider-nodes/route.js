import { NextResponse } from "next/server";
import { createProviderNode, getProviderNodes } from "@/models";
import { OPENAI_COMPATIBLE_PREFIX, ANTHROPIC_COMPATIBLE_PREFIX, CUSTOM_EMBEDDING_PREFIX } from "@/shared/constants/providers";
import { generateId } from "@/shared/utils";
import { sanitizeNodeQuirks } from "@/shared/utils/nodeQuirks";
import { prefixFormatProblem, prefixProblem } from "@/shared/utils/reservedPrefixes";

export const dynamic = "force-dynamic";

const OPENAI_COMPATIBLE_DEFAULTS = {
  baseUrl: "https://api.openai.com/v1",
};

const ANTHROPIC_COMPATIBLE_DEFAULTS = {
  baseUrl: "https://api.anthropic.com/v1",
};

const CUSTOM_EMBEDDING_DEFAULTS = {
  baseUrl: "https://api.openai.com/v1",
};

// Compare base URLs the way the POST below stores them.
const trimUrl = (u) => String(u || "").trim().replace(/\/+$/, "").replace(/\/(messages|embeddings)$/, "");

// GET /api/provider-nodes - List all provider nodes
export async function GET() {
  try {
    const nodes = await getProviderNodes();
    return NextResponse.json({ nodes });
  } catch (error) {
    console.log("Error fetching provider nodes:", error);
    return NextResponse.json({ error: "Failed to fetch provider nodes" }, { status: 500 });
  }
}

// POST /api/provider-nodes - Create provider node
export async function POST(request) {
  try {
    const body = await request.json();
    const { name, prefix, apiType, baseUrl, type } = body;
    // Optional, from "Add endpoint" detection. Older callers don't send them.
    const quirks = sanitizeNodeQuirks(body.quirks);
    const verified = typeof body.verified === "boolean" ? { verified: body.verified } : {};

    if (!name?.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    if (typeof prefix !== "string" || !prefix.trim()) {
      return NextResponse.json({ error: "Prefix is required", field: "prefix" }, { status: 400 });
    }
    const formatProblem = prefixFormatProblem(prefix);
    if (formatProblem) {
      return NextResponse.json({ error: formatProblem, field: "prefix" }, { status: 400 });
    }

    // Determine type
    const nodeType = type || "openai-compatible";

    // A retried save (the first response was lost) must not make a second node:
    // the same type + prefix + base URL is the same endpoint, so return it.
    const nodes = await getProviderNodes();
    const sameEndpoint = nodes.find((n) => n.type === nodeType
      && String(n.prefix || "").trim().toLowerCase() === prefix.trim().toLowerCase()
      && trimUrl(n.baseUrl) === trimUrl(baseUrl)
      && (nodeType !== "openai-compatible" || n.apiType === apiType));
    if (sameEndpoint && baseUrl) {
      return NextResponse.json({ node: sameEndpoint, existing: true }, { status: 200 });
    }

    // Built-in provider names win at routing time, and two nodes can't share one.
    const problem = prefixProblem(prefix, { nodes });
    if (problem) {
      return NextResponse.json({ error: problem, field: "prefix" }, { status: 400 });
    }

    if (nodeType === "openai-compatible") {
      if (!apiType || !["chat", "responses"].includes(apiType)) {
        return NextResponse.json({ error: "Invalid OpenAI compatible API type" }, { status: 400 });
      }

      const node = await createProviderNode({
        id: `${OPENAI_COMPATIBLE_PREFIX}${apiType}-${generateId()}`,
        type: "openai-compatible",
        prefix: prefix.trim(),
        apiType,
        baseUrl: (baseUrl || OPENAI_COMPATIBLE_DEFAULTS.baseUrl).trim(),
        name: name.trim(),
        ...quirks,
        ...verified,
      });
      return NextResponse.json({ node }, { status: 201 });
    }

    if (nodeType === "custom-embedding") {
      // Strip trailing slash and /embeddings if user pasted full endpoint
      let sanitizedBaseUrl = (baseUrl || CUSTOM_EMBEDDING_DEFAULTS.baseUrl).trim().replace(/\/$/, "");
      if (sanitizedBaseUrl.endsWith("/embeddings")) {
        sanitizedBaseUrl = sanitizedBaseUrl.slice(0, -"/embeddings".length);
      }

      const node = await createProviderNode({
        id: `${CUSTOM_EMBEDDING_PREFIX}${generateId()}`,
        type: "custom-embedding",
        prefix: prefix.trim(),
        baseUrl: sanitizedBaseUrl,
        name: name.trim(),
      });
      return NextResponse.json({ node }, { status: 201 });
    }

    if (nodeType === "anthropic-compatible") {
      // Sanitize Base URL: remove trailing slash, and remove trailing /messages if user added it
      // This prevents double-appending /messages at runtime
      let sanitizedBaseUrl = (baseUrl || ANTHROPIC_COMPATIBLE_DEFAULTS.baseUrl).trim().replace(/\/$/, "");
      if (sanitizedBaseUrl.endsWith("/messages")) {
        sanitizedBaseUrl = sanitizedBaseUrl.slice(0, -9); // remove /messages
      }

      const node = await createProviderNode({
        id: `${ANTHROPIC_COMPATIBLE_PREFIX}${generateId()}`,
        type: "anthropic-compatible",
        prefix: prefix.trim(),
        baseUrl: sanitizedBaseUrl,
        name: name.trim(),
        ...quirks,
        ...verified,
      });
      return NextResponse.json({ node }, { status: 201 });
    }

    return NextResponse.json({ error: "Invalid provider node type" }, { status: 400 });
  } catch (error) {
    console.log("Error creating provider node:", error);
    return NextResponse.json({ error: "Failed to create provider node" }, { status: 500 });
  }
}
