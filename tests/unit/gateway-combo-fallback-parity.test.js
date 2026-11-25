// Golden fixtures for the Go gateway's combo fallback and account loop
// (gateway/internal/combo Run, gateway/internal/accounts RunModel;
// docs/GO_GATEWAY.md "Phase 2c").
//
// Each scenario is a real Node database (sql.js) with custom nodes, keys and
// combos, and a scripted upstream: Node's real handleChat serves a sequence
// of /v1/messages requests, and only proxyAwareFetch is replaced, answering
// each key from its script. Everything above it is Node's own code: the
// executor's retries and headers timer, parseUpstreamError, chatCore, the
// account loop, combo fallback and the locks it writes.
//
// The clock is fake. Every wait the routing makes (an executor's retry
// delay, combo.js's transient wait, a warm-key wait) is recorded and moves
// the clock by its length at once. For each request the fixture holds the
// events in order (each send, each wait and each chatCore result), the reply
// (status, headers, body) and every connection row after it. The Go test
// replays the chatCore results through its own loop and combo fallback on the
// same rows and must make the same waits and attempts, give the same reply
// and leave the same rows.
//
// testdata/capabilities.json holds detectRequiredCapabilities on many bodies:
// Go declines every body whose set Node finds non-empty (MayNeedCapability).
//
// Without COMBO_RECORD this checks that Node still makes the committed files.
// With COMBO_RECORD=1 it writes them.
import { describe, it, expect, vi, afterAll } from "vitest";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { closeRepos, openRepos, tempDataDir } from "../helpers/nodeDb.js";

for (const name of ["CACHE_AFFINITY_TTL_MS", "CACHE_AFFINITY_MAX_WAIT_MS", "CACHE_AFFINITY_MIN_TOKENS", "SAME_REQUEST_ERROR_STOP_AFTER", "UPSTREAM_STREAM_HEADERS_TIMEOUT_MS", "FETCH_CONNECT_TIMEOUT_MS", "STREAM_EARLY_HEADERS_MS"]) delete process.env[name];

const DIR = fileURLToPath(new URL("../../gateway/internal/combo/testdata/", import.meta.url));
const RECORD = process.env.COMBO_RECORD === "1";
const T0 = Date.parse("2026-03-01T12:00:00.000Z");
const S = 1000;
const iso = (ms) => new Date(ms).toISOString();

const HOT = "openai-compatible-chat-hot";
const COLD = "openai-compatible-chat-cold";
const BASE = "https://gateway.example.test/v1";
const MODELS = ["m1", "m2"];

// The scripted upstream, shared with the mocks below (vi.hoisted survives the
// module resets openRepos makes).
const world = vi.hoisted(() => ({ scripts: {}, used: {}, events: [] }));

vi.mock("../../open-sse/utils/proxyFetch.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    proxyAwareFetch: async (url, init) => {
      const auth = Object.values(init.headers || {}).map(String).join(" ");
      const id = /key-(\w+)/.exec(auth)?.[1];
      world.events.push({ send: id });
      const script = world.scripts[id] || [];
      const n = world.used[id] = (world.used[id] || 0) + 1;
      const step = script[Math.min(n, script.length) - 1];
      if (!step) throw new Error(`no script for ${id}`);
      if (step === "ok") return new Response(SSE_OK, { status: 200, headers: { "content-type": "text/event-stream" } });
      if (step === "timeout") {
        // undici's own headers timeout, after the stream's whole budget.
        world.events.push({ sleep: 240 * S, by: "upstream" });
        vi.setSystemTime(Date.now() + 240 * S);
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_HEADERS_TIMEOUT", message: "Headers Timeout Error" } });
      }
      return new Response(step.body, { status: step.status, headers: { "content-type": "application/json", ...(step.headers || {}) } });
    },
  };
});

vi.mock("../../open-sse/handlers/chatCore.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    handleChatCore: async (args) => {
      const result = await actual.handleChatCore(args);
      world.events.push({
        attempt: {
          connectionId: args.connectionId, provider: args.modelInfo.provider, model: args.modelInfo.model,
          success: result.success === true, status: result.status ?? 0, error: result.error ?? "",
          resetsAtMs: result.resetsAtMs ?? 0, headersTimeout: result.headersTimeout ? { stream: result.headersTimeout.stream } : null,
        },
      });
      return result;
    },
  };
});

const SSE_OK = [
  ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "m1", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
  ["message_stop", { type: "message_stop" }],
].map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");

const err = (status, message) => ({ status, body: JSON.stringify({ error: { message } }) });
const RL = err(429, "Rate limit exceeded");
const E500 = err(500, "Internal error");
const OVER = err(503, "The model is overloaded");
const BAD = err(400, "improperly formed request");
const LONG = err(400, "prompt is too long: 250000 tokens > 200000 maximum");
const SCHEMA = err(400, "input_schema is invalid for tools.3");

const CC_HEADERS = { "content-type": "application/json", "user-agent": "claude-cli/2.1.258 (external, cli)", "x-app": "cli", "anthropic-version": "2023-06-01" };

// A request's body from its spec; the Go test builds the same one.
function bodyFor(spec) {
  const body = { model: spec.model, max_tokens: 1024, stream: true };
  if (spec.bigSystem) body.system = [{ type: "text", text: "lorem ".repeat(spec.bigSystem), cache_control: { type: "ephemeral" } }];
  body.messages = [{ role: "user", content: spec.text || "Explain the build failure in step three." }];
  return body;
}

const node = (id, prefix) => ({ id, prefix });
const conn = (id, provider, priority, data = {}, psd = {}) => ({
  id, provider, priority,
  data: { apiKey: `key-${id}`, providerSpecificData: { apiType: "chat", baseUrl: BASE, modelRoutes: Object.fromEntries(MODELS.map((m) => [m, "anthropic"])), ...psd }, ...data },
});
const NODES = [node(HOT, "hot"), node(COLD, "cold")];
const COMBOS = { main: ["hot/m1", "cold/m1"], outer: ["main", "hot/m2"], solo: ["hot/m1"] };

const SCENARIOS = [
  {
    name: "one key serves",
    connections: [conn("k1", HOT, 1)],
    upstream: { k1: ["ok"] },
    requests: [{ model: "hot/m1" }, { model: "hot/m1" }],
  },
  {
    name: "the next key after a rate limit",
    connections: [conn("k1", HOT, 1), conn("k2", HOT, 2)],
    upstream: { k1: [RL], k2: ["ok"] },
    requests: [{ model: "hot/m1" }, { model: "hot/m1" }],
  },
  {
    name: "a combo falls through to its next member",
    connections: [conn("k1", HOT, 1), conn("k2", HOT, 2), conn("c1", COLD, 1)],
    upstream: { k1: [E500], k2: [E500], c1: ["ok"] },
    requests: [{ model: "main" }],
  },
  {
    name: "the transient wait between members",
    connections: [conn("k1", HOT, 1), conn("c1", COLD, 1)],
    upstream: { k1: [OVER], c1: ["ok"] },
    requests: [{ model: "main" }],
  },
  {
    name: "every member fails",
    connections: [conn("k1", HOT, 1), conn("c1", COLD, 1)],
    upstream: { k1: [E500], c1: [BAD] },
    requests: [{ model: "main" }, { model: "solo" }],
  },
  {
    name: "a nested combo",
    connections: [conn("k1", HOT, 1)],
    upstream: { k1: [E500, "ok"] },
    requests: [{ model: "outer" }],
  },
  {
    name: "every key locked, then free",
    connections: [
      conn("k1", HOT, 1, { modelLock_m1: iso(T0 + 90 * S), modelLimit_m1: true, errorCode: 429, lastError: "[429]: Rate limit exceeded", testStatus: "unavailable", backoffLevel: 1 }),
      conn("k2", HOT, 2, { modelLock_m1: iso(T0 + 120 * S), errorCode: 500, lastError: "[500]: Internal error", testStatus: "unavailable" }),
    ],
    upstream: { k1: ["ok"] },
    requests: [{ model: "hot/m1" }, { model: "main" }, { model: "hot/m1", advanceMs: 91 * S }],
  },
  {
    name: "the same request error from enough keys",
    connections: [conn("k1", HOT, 1), conn("k2", HOT, 2), conn("k3", HOT, 3)],
    upstream: { k1: [LONG], k2: [LONG], k3: ["ok"] },
    requests: [{ model: "hot/m1" }],
  },
  {
    name: "header timeouts, then a hung model",
    connections: [conn("k1", HOT, 1), conn("k2", HOT, 2), conn("k3", HOT, 3)],
    upstream: { k1: ["timeout"], k2: ["timeout"], k3: ["timeout"] },
    requests: [{ model: "hot/m1" }, { model: "hot/m1", advanceMs: 5 * S }, { model: "hot/m1", advanceMs: 5 * S }],
  },
  {
    name: "a request error locks nothing",
    connections: [conn("k1", HOT, 1), conn("k2", HOT, 2)],
    upstream: { k1: [BAD], k2: ["ok"] },
    requests: [{ model: "hot/m1" }],
  },
  {
    name: "a warm key waits out its short lock",
    connections: [conn("k1", HOT, 1), conn("k2", HOT, 2)],
    upstream: { k1: ["ok", RL, "ok"], k2: ["ok"] },
    requests: [{ model: "hot/m1", bigSystem: 22000 }, { model: "hot/m1", bigSystem: 22000, advanceMs: 10 * S }],
  },
  {
    name: "round-robin keys",
    settings: { fallbackStrategy: "round-robin", stickyRoundRobinLimit: 1 },
    connections: [conn("k1", HOT, 1), conn("k2", HOT, 2)],
    upstream: { k1: ["ok"], k2: ["ok"] },
    requests: [{ model: "hot/m1" }, { model: "hot/m1", advanceMs: 10 }, { model: "hot/m1", advanceMs: 10 }],
  },
  {
    name: "a member with no keys",
    connections: [conn("k1", HOT, 1)],
    upstream: { k1: [E500] },
    requests: [{ model: "main" }, { model: "cold/m1" }],
  },
  {
    name: "the same limit message from two upstreams",
    connections: [conn("k1", HOT, 1), conn("k2", HOT, 2, {}, { baseUrl: "https://other.example.test/v1" }), conn("k3", HOT, 3)],
    upstream: { k1: [LONG], k2: [LONG], k3: ["ok"] },
    requests: [{ model: "hot/m1" }],
  },
  {
    // Node weighs a 401 as dead-key evidence it keeps in memory: Go hands
    // the request over before its first byte (goHandoff).
    name: "a 401 goes to Node",
    goHandoff: "401",
    connections: [conn("k1", HOT, 1), conn("k2", HOT, 2)],
    upstream: { k1: [err(401, "Invalid API key")], k2: ["ok"] },
    requests: [{ model: "hot/m1" }],
  },
  {
    name: "every key refuses the request",
    connections: [conn("k1", HOT, 1), conn("k2", HOT, 2)],
    // Request errors with different words: nothing is locked and no two
    // keys agree, so the walk ends with every key tried.
    upstream: { k1: [err(400, "Unknown parameter: frobnicate")], k2: [err(400, "Unknown parameter: wibble")] },
    requests: [{ model: "hot/m1" }],
  },
  {
    name: "a warm key rate-limited twice",
    connections: [conn("k1", HOT, 1), conn("k2", HOT, 2)],
    upstream: { k1: ["ok", RL, RL, "ok"], k2: ["ok"] },
    requests: [{ model: "hot/m1", bigSystem: 22000 }, { model: "hot/m1", bigSystem: 22000, advanceMs: 10 * S }],
  },
  {
    name: "keys on different upstreams keep walking",
    connections: [conn("k1", HOT, 1), conn("k2", HOT, 2, {}, { baseUrl: "https://other.example.test/v1" }), conn("k3", HOT, 3)],
    upstream: { k1: [SCHEMA], k2: [SCHEMA], k3: ["ok"] },
    requests: [{ model: "hot/m1" }],
  },
];

const HEADER_NAMES = ["content-type", "retry-after", "access-control-allow-origin"];

// Waits the routing makes, by the file that set the timer: recorded, and
// passed on the fake clock at once. Every other timer runs as it would.
function installSleepShim() {
  const real = globalThis.setTimeout;
  globalThis.setTimeout = function (fn, ms, ...args) {
    const caller = (new Error().stack || "").split("\n")[2] || "";
    const by = caller.includes("services/combo.js") ? "combo" : caller.includes("executors/base.js") ? "retry" : caller.includes("utils/abortableSleep.js") ? "warm" : null;
    if (by && ms > 0) {
      world.events.push({ sleep: ms, by });
      vi.setSystemTime(Date.now() + ms);
      return real(fn, 0, ...args);
    }
    return real(fn, ms, ...args);
  };
  return () => { globalThis.setTimeout = real; };
}

async function runScenario(scenario, dir) {
  // Routing state Node keeps on global, which outlives the module reset.
  delete global._authEvents;
  delete global._modelHang;
  delete global._selectionMutexes;
  const { adapter, repos } = await openRepos("sql.js", dir);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const restore = installSleepShim();
  world.scripts = scenario.upstream;
  world.used = {};
  try {
    // A local client without a key, as the hot path's are.
    await repos.updateSettings({ requireApiKey: false, ...scenario.settings });
    for (const n of NODES) {
      adapter.run(`INSERT INTO providerNodes(id, type, name, data, createdAt, updatedAt) VALUES(?, 'openai-compatible', ?, ?, ?, ?)`,
        [n.id, n.prefix, JSON.stringify({ prefix: n.prefix, apiType: "chat", baseUrl: BASE }), iso(T0 - 7200 * S), iso(T0 - 7200 * S)]);
    }
    for (const [name, models] of Object.entries(COMBOS)) {
      adapter.run(`INSERT INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, NULL, ?, ?, ?)`, [`combo-${name}`, name, JSON.stringify(models), iso(T0 - 7200 * S), iso(T0 - 7200 * S)]);
    }
    for (const c of scenario.connections) {
      adapter.run(
        `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES(?, ?, 'apikey', ?, NULL, ?, 1, ?, ?, ?)`,
        [c.id, c.provider, c.id, c.priority, JSON.stringify(c.data), iso(T0 - 3600 * S), iso(T0 - 3600 * S)],
      );
    }
    const tables = (name) => adapter.all(`SELECT * FROM ${name} ORDER BY rowid`);
    const initial = { providerNodes: tables("providerNodes"), combos: tables("combos"), providerConnections: tables("providerConnections") };
    const settingsRow = adapter.get(`SELECT data FROM settings WHERE id = 1`)?.data ?? null;
    const rows = () => adapter.all(`SELECT id, isActive, data, updatedAt FROM providerConnections ORDER BY rowid`);
    const { handleChat } = await import("../../src/sse/handlers/chat.ts");
    const requests = [];
    for (const spec of scenario.requests) {
      if (spec.advanceMs) vi.setSystemTime(Date.now() + spec.advanceMs);
      const startMs = Date.now();
      world.events = [];
      const request = new Request("http://localhost:20128/v1/messages", { method: "POST", headers: CC_HEADERS, body: JSON.stringify(bodyFor(spec)) });
      const res = await handleChat(request);
      const text = await res.text();
      // The success path clears the key's error in a promise of its own.
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      const headers = Object.fromEntries(HEADER_NAMES.filter((h) => res.headers.has(h)).map((h) => [h, res.headers.get(h)]));
      requests.push({
        ...spec, startMs, endMs: Date.now(), events: world.events,
        reply: res.ok ? { status: res.status, ok: true } : { status: res.status, headers, body: text },
        rows: rows(),
      });
    }
    return { name: scenario.name, goHandoff: scenario.goHandoff || "", settings: settingsRow, initial, requests };
  } finally {
    restore();
    vi.restoreAllMocks();
    vi.useRealTimers();
    closeRepos();
  }
}

// ── Capabilities ─────────────────────────────────────────────────────────────

const user = (content, extra = {}) => ({ role: "user", content, ...extra });
const assistant = (content) => ({ role: "assistant", content });
const CAPABILITY_BODIES = [
  { messages: [user("hi")] },
  { messages: [user([{ type: "text", text: "hi" }])] },
  { messages: [user([{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } }])] },
  { messages: [user([{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } }]), assistant("seen"), user("and now?")] },
  { messages: [user([{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBER" } }])] },
  { messages: [user([{ type: "document", source: { type: "text", media_type: "text/plain", data: "plain" } }])] },
  { messages: [user([{ type: "tool_result", tool_use_id: "t1", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "x" } }] }])] },
  { messages: [user("look: data:image/png;base64,AAAA")] },
  { messages: [user("listen: data:audio/wav;base64,AAAA")] },
  { messages: [user("read: data:application/pdf;base64,AAAA")] },
  { messages: [user([{ type: "text", text: "data:image/png;base64,AAAA" }])] },
  { messages: [user("x", { images: ["a.png"] })] },
  { messages: [user("x", { images: [] })] },
  { messages: [user("x", { attachments: [{ contentType: "image/png" }] })] },
  { messages: [user("x", { attachments: [{ contentType: "text/plain" }] })] },
  { messages: [user("x", { experimental_attachments: [{ url: "https://files.example.test/a" }] })] },
  { messages: [user("x", { attachments: [null, 0] })] },
  { messages: [user("x", { image_url: "u" })] },
  { messages: [user("x", { audio: { data: "x" } })] },
  { messages: [user([{ type: "input_audio", input_audio: { data: "x", format: "wav" } }])] },
  { messages: [user([{ type: "video_url", video_url: { url: "u" } }])] },
  { messages: [user([{ type: "text", text: "x", inlineData: { mimeType: "image/png" } }])] },
  { messages: [user([{ type: "text", text: "x", fileData: { mimeType: "text/csv" } }])] },
  { messages: [user([null, "text", 5, { type: "text", text: "x" }])] },
  { messages: [assistant([{ type: "image", source: { type: "base64", media_type: "image/png", data: "x" } }])] },
  { messages: [user([{ type: "image", source: { type: "url", url: "u" } }]), { role: "model", content: "ok" }] },
  { messages: [user("x")], tools: [{ type: "web_search_20250305", name: "web_search" }] },
  { messages: [user("x")], tools: [{ name: "Read", input_schema: { type: "object" } }, null] },
  { messages: [user("x")], tools: [{ type: "web_search" }] },
  { messages: [user("x")], tools: [{ type: "google_search" }] },
  { messages: [user("x")], tools: "not an array" },
  { messages: "not an array" },
  { messages: [] },
  { messages: [5, null, "x"] },
];

function capabilityCases() {
  return CAPABILITY_BODIES.map((body) => ({ body, required: [...comboModule.detectRequiredCapabilities(body)].sort() }));
}

let comboModule;

const dirs = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("combo fallback fixtures for the Go gateway", () => {
  it("keeps the capability detection cases", async () => {
    comboModule = await import("../../open-sse/services/combo.js");
    const text = JSON.stringify(capabilityCases(), null, 1) + "\n";
    if (RECORD) writeFileSync(`${DIR}capabilities.json`, text);
    expect(readFileSync(`${DIR}capabilities.json`, "utf8"), "regenerate with COMBO_RECORD=1").toBe(text);
  });

  it("keeps the routing scenarios", async () => {
    const out = [];
    for (const scenario of SCENARIOS) {
      const dir = tempDataDir("gateway-combo-fallback-");
      dirs.push(dir);
      const recorded = await runScenario(scenario, dir);
      // A scenario that never reached the routing proves nothing.
      expect(recorded.requests.some((r) => r.events.length > 0), `${scenario.name}: no request was routed`).toBe(true);
      out.push(recorded);
    }
    const text = JSON.stringify(out, null, 1) + "\n";
    if (RECORD) writeFileSync(`${DIR}fallback.json`, text);
    expect(readFileSync(`${DIR}fallback.json`, "utf8"), "Node's routing changed: regenerate with COMBO_RECORD=1 and update gateway/internal/combo or accounts").toBe(text);
  }, 120000);
});
