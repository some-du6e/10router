// Golden fixtures for the Go gateway's Claude request preparation
// (gateway/internal/claudeprep, docs/GO_GATEWAY.md "Parity testing").
//
// Each corpus case (tests/helpers/claudeprepCorpus.js) goes through Node's real
// path for POST /v1/messages to an openai-compatible-chat-* node that routes
// the model to the Anthropic Messages API: chat.ts's body steps, then
// handleChatCore and the DefaultExecutor with its endpoint overrides. The
// recorder sits under the executor, at its fetch: what it captures is the URL,
// the headers object and the exact body bytes Node would have sent. Nothing
// leaves the process.
//
// Without CLAUDEPREP_RECORD this checks that Node still produces the committed
// fixtures and table export, so a Node change that would break the Go port's
// byte parity fails here too. With CLAUDEPREP_RECORD=1 it writes them
// (CLAUDEPREP_OUT: another directory; CLAUDEPREP_LARGE=1: the large corpus CI
// generates).
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const sent = [];
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: async (url, init) => {
    sent.push({ url, init });
    const sse = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_synthetic\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  },
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn(async () => new Proxy({}, {
    get: (target, key) => (key === "then" ? undefined : (target[key] ??= () => {})),
  })),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { stripModelContextMarker } = await import("../../open-sse/utils/modelMarkers.js");
const caps = await import("../../open-sse/providers/capabilities.js");
const levels = await import("../../open-sse/providers/thinkingLevels.js");
const vision = await import("../../open-sse/providers/visionPatterns.js");
const { MIMIC_HEADERS } = await import("../../src/shared/utils/nodeQuirks.js");
const { buildCorpus } = await import("../helpers/claudeprepCorpus.js");

const GATEWAY_DIR = fileURLToPath(new URL("../../gateway/internal/claudeprep/", import.meta.url));
const FIXTURE_DIR = join(GATEWAY_DIR, "testdata", "fixtures");
const TABLES_FILE = join(GATEWAY_DIR, "tables.json");
const RECORD = process.env.CLAUDEPREP_RECORD === "1";
const LARGE = process.env.CLAUDEPREP_LARGE === "1";
const OUT_DIR = process.env.CLAUDEPREP_OUT || FIXTURE_DIR;

// The data tables the Go port embeds instead of restating (capabilities,
// thinking levels, vision name patterns, client identities). Written in record
// mode, checked otherwise.
function tablesText() {
  const tables = {
    defaultCapabilities: caps.DEFAULT_CAPABILITIES,
    modelCapabilities: caps.MODEL_CAPABILITIES,
    providerCapabilities: caps.PROVIDER_CAPABILITIES,
    patternCapabilities: caps.PATTERN_CAPABILITIES,
    thinkingFormatLevels: levels.FORMAT_LEVELS,
    thinkingPatternLevels: levels.PATTERN_THINKING,
    thinkingDefaultLevels: levels.L.base,
    visionNotPattern: vision.NOT_VISION.source,
    visionPattern: vision.VISION_NAME.source,
    mimicHeaders: MIMIC_HEADERS,
  };
  return JSON.stringify(tables, null, 2) + "\n";
}

const redact = (value, inputs) => {
  let out = String(value);
  if (inputs.apiKey) out = out.split(inputs.apiKey).join("{{apiKey}}");
  return out;
};

// One case through Node, as chat.ts and chatCore run it.
async function runNode(fixture) {
  const { inputs, request } = fixture;
  const bytes = request.bodyBase64 ? Buffer.from(request.bodyBase64, "base64") : Buffer.from(request.body, "utf8");
  // readJsonObject: request.text() (UTF-8, replacement characters, BOM dropped), then JSON.parse.
  const body = JSON.parse(await new Response(bytes).text());
  // chat.ts, before routing: the context marker, then a budgeted key's fields.
  const { model: modelStr, contextMarker } = stripModelContextMarker(body.model);
  if (contextMarker) body.model = modelStr;
  if (inputs.keyHasBudget) {
    delete body.speed;
    delete body.service_tier;
  }
  const catalog = inputs.catalog;
  caps.setCatalogSource(catalog ? {
    getModalities: (model) => catalog.modalities?.[model] || null,
    getLimits: (provider, model) => catalog.limits?.[`${provider} ${model}`] || null,
  } : null);
  const credentials = {
    apiKey: inputs.apiKey,
    connectionId: "conn-synthetic-0001",
    connectionName: "synthetic",
    providerSpecificData: structuredClone(inputs.providerSpecificData),
  };
  sent.length = 0;
  let result;
  try {
    result = await handleChatCore({
      body: { ...body, model: `${inputs.provider}/${inputs.model}` },
      modelInfo: { provider: inputs.provider, model: inputs.model },
      credentials,
      log: null,
      clientRawRequest: { endpoint: "/v1/messages", body, headers: request.headers },
      connectionId: "conn-synthetic-0001",
      userAgent: request.headers["user-agent"] || "",
      apiKey: null,
      ccFilterNaming: false,
      providerThinking: inputs.providerThinking,
      sourceFormatOverride: "claude",
    });
  } catch (error) {
    return { error: `threw: ${error?.message || String(error)}` };
  } finally {
    caps.setCatalogSource(null);
  }
  await result?.response?.body?.cancel?.().catch?.(() => {});
  if (sent.length !== 1) return { error: `sent ${sent.length} upstream requests` };
  const { url, init } = sent[0];
  const out = Buffer.from(init.body);
  return {
    url,
    headers: Object.entries(init.headers).map(([k, v]) => [k, redact(v, inputs)]),
    body: out.toString("utf8"),
    sha256: createHash("sha256").update(out).digest("hex"),
  };
}

const corpus = buildCorpus({ large: LARGE });

describe("Claude request preparation fixtures for the Go gateway", () => {
  beforeAll(() => {
    if (RECORD) mkdirSync(OUT_DIR, { recursive: true });
  });
  afterAll(() => caps.setCatalogSource(null));

  it("keeps the table export the Go port embeds", () => {
    if (RECORD && OUT_DIR === FIXTURE_DIR) writeFileSync(TABLES_FILE, tablesText());
    expect(readFileSync(TABLES_FILE, "utf8"), "regenerate with CLAUDEPREP_RECORD=1").toBe(tablesText());
  });

  it("has a production-shaped corpus", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(LARGE ? 400 : 100);
  });

  for (const fixture of corpus) {
    it(fixture.name, async () => {
      const node = await runNode(fixture);
      const text = JSON.stringify({ ...fixture, node }, null, 1) + "\n";
      const file = join(OUT_DIR, `${fixture.name}.json`);
      if (RECORD) {
        writeFileSync(file, text);
        return;
      }
      expect(existsSync(file), `${file} is missing: regenerate with CLAUDEPREP_RECORD=1`).toBe(true);
      expect(readFileSync(file, "utf8"), "Node's Claude prep changed: regenerate the fixtures and update gateway/internal/claudeprep").toBe(text);
    });
  }

  it("has no stale fixture files", () => {
    if (RECORD && OUT_DIR !== FIXTURE_DIR) return;
    const names = new Set(corpus.map((f) => `${f.name}.json`));
    const stale = readdirSync(OUT_DIR).filter((f) => f.endsWith(".json") && !names.has(f));
    expect(stale).toEqual([]);
  });
});
