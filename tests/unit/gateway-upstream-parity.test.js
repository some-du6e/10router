// Golden fixtures for the Go gateway's sender (gateway/internal/upstream,
// docs/GO_GATEWAY.md "Phase 2c").
//
//  - tables.json: the retry config, the headers budget's constants and the
//    proxy route names the Go port embeds, never restated in Go.
//  - testdata/vectors.json: upstreamHeadersBudget and its timeout text under
//    many environment overrides, parseRejectedBetas, and resolveProxyChain
//    with networkPath's transport key.
//  - testdata/wire.json: Node's real handleChat sending through its real
//    DefaultExecutor and proxyAwareFetch (undici) to a local server that
//    answers from a script. For each scenario: every request the server got
//    (method, path, headers, body; the host left out), every retry wait, the
//    attempt's result as chatCore reports it, each headers budget, and the beta
//    flags Node saved. The Go test answers its own sender from the same script
//    and must send the same requests and come to the same result.
//
// Without UPSTREAM_RECORD this checks that Node still makes the committed
// files. With UPSTREAM_RECORD=1 it writes them.
import { describe, it, expect, vi, afterAll } from "vitest";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { closeRepos, openRepos, tempDataDir } from "../helpers/nodeDb.js";

const ENV = ["UPSTREAM_STREAM_HEADERS_TIMEOUT_MS", "FETCH_CONNECT_TIMEOUT_MS", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
for (const name of ENV) delete process.env[name];

const DIR = fileURLToPath(new URL("../../gateway/internal/upstream/", import.meta.url));
const RECORD = process.env.UPSTREAM_RECORD === "1";
const PROVIDER = "openai-compatible-chat-hot";
const S = 1000;

const world = vi.hoisted(() => ({ events: [] }));

vi.mock("../../open-sse/handlers/chatCore.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    handleChatCore: async (args) => {
      const result = await actual.handleChatCore(args);
      world.events.push({
        attempt: {
          connectionId: args.connectionId, success: result.success === true, status: result.status ?? 0, error: result.error ?? "",
          headersTimeout: result.headersTimeout ? { stream: result.headersTimeout.stream } : null,
        },
      });
      return result;
    },
  };
});

vi.mock("../../open-sse/services/modelHang.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, noteProbeBudget: (provider, model, requestId, budgetMs) => { world.events.push({ budget: budgetMs }); return actual.noteProbeBudget(provider, model, requestId, budgetMs); } };
});

// ── Tables and vectors ───────────────────────────────────────────────────────

async function tablesText() {
  const runtime = await import("../../open-sse/config/runtimeConfig.js");
  const { HEADERS_TIMEOUT } = await import("../../open-sse/config/errorConfig.js");
  const { BETA_HEADER_KEYS } = await import("../../open-sse/utils/anthropicBeta.ts");
  const routing = await import("../../src/lib/network/proxyRouting.ts");
  const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
  const exec = new DefaultExecutor(PROVIDER);
  const merged = { ...runtime.DEFAULT_RETRY_CONFIG, ...exec.config.retry };
  const retryConfig = {};
  for (const [status, entry] of Object.entries(merged)) {
    if (entry == null) continue;
    retryConfig[status] = typeof entry === "number" ? { number: entry } : { attempts: entry.attempts ?? null, delayMs: entry.delayMs ?? null };
  }
  return JSON.stringify({
    retryConfig,
    retryDelayMs: runtime.RETRY_CONFIG.delayMs,
    executor: { timeoutMs: exec.config.timeoutMs || 0, headersTimeoutAttempts: exec.config.headersTimeoutAttempts || 0, fallbackCount: exec.getFallbackCount() },
    fetchConnectTimeoutMs: runtime.FETCH_CONNECT_TIMEOUT_MS,
    headersTimeoutAttempts: runtime.HEADERS_TIMEOUT_ATTEMPTS,
    maxTimerMs: runtime.MAX_TIMER_MS,
    headersTimeoutText: HEADERS_TIMEOUT.text,
    betaHeaderKeys: BETA_HEADER_KEYS,
    proxyDirect: routing.PROXY_DIRECT,
    relayTypes: [...routing.RELAY_TYPES].sort(),
  }, null, 2) + "\n";
}

const ENV_VALUES = ["", "5000", " 7000", "5m", "0", "-5", "1e4", "0x10", "abc", "2147483647", "2147483648", "+300", "1500", " 900"];

async function budgetCases() {
  const out = [];
  for (const name of ["UPSTREAM_STREAM_HEADERS_TIMEOUT_MS", "FETCH_CONNECT_TIMEOUT_MS"]) {
    for (const value of ENV_VALUES) {
      process.env[name] = value;
      vi.resetModules();
      const runtime = await import("../../open-sse/config/runtimeConfig.js");
      const { UpstreamHeadersTimeoutError } = await import("../../open-sse/utils/headersTimeout.js");
      for (const stream of [true, false]) {
        const b = runtime.upstreamHeadersBudget({ stream });
        out.push({ env: { [name]: value }, stream, ms: b.ms, setBy: b.setBy, text: new UpstreamHeadersTimeoutError(b.ms, { stream, setBy: b.setBy }).message });
      }
      delete process.env[name];
    }
  }
  vi.resetModules();
  return out;
}

const REJECTIONS = [
  "Unexpected value(s) `interleaved-thinking-2025-05-14` for the `anthropic-beta` header. Please consult our documentation at docs.example.test or try again without the header.",
  "{\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"Unexpected value(s) `a-1`, `b-2` for the `anthropic-beta` header.\"}}",
  "unexpected VALUE(S)   ` spaced-flag ` for the anthropic-beta HEADER",
  "Unexpected value(s) `x`\nfor the `anthropic-beta` header",
  "Unexpected value(s) for the `anthropic-beta` header",
  "Unexpected value(s) `` for the `anthropic-beta` header",
  "Unexpected values `a` for the `anthropic-beta` header",
  "Unexpected value(s) `a` for the anthropic-version header",
  "Unexpected value(s) `Kelvin` for the `anthropic-beta` header",
  "Unexpected value(s) `nbsp` for the `anthropic-beta` header",
  "",
  "model not found",
];

function proxyCases(routing) {
  const pools = {
    on: { id: "on", name: "Main", proxyUrl: " http://proxy.example.test:8080 ", noProxy: "a.test", isActive: true },
    strict: { id: "strict", proxyUrl: "http://proxy.example.test:8081", isActive: true, strictProxy: true },
    off: { id: "off", name: "Old", proxyUrl: "http://proxy.example.test:8082", isActive: false },
    blank: { id: "blank", proxyUrl: "  ", isActive: true },
    relay: { id: "relay", proxyUrl: "https://relay.example.test", isActive: true, type: "vercel", noProxy: "x.test" },
    named: { id: "named", name: "", proxyUrl: "http://proxy.example.test:8083", isActive: false },
  };
  const layers = [
    {}, { account: { proxyPoolId: "on" } }, { account: { proxyPoolId: " on " } }, { account: { proxyPoolId: "__none__" }, global: "strict" },
    { account: { proxyPoolId: "__direct__" }, global: "on" }, { account: { proxyPoolId: "gone" } }, { account: { proxyPoolId: "off" } },
    { account: { proxyPoolId: "blank" } }, { account: { proxyPoolId: "relay" } }, { account: { proxyPoolId: "named" } },
    { account: { connectionProxyEnabled: true, connectionProxyUrl: " http://legacy.example.test:3128 ", connectionNoProxy: "b.test" } },
    { account: { connectionProxyEnabled: true, connectionProxyUrl: "  " }, provider: "on" },
    { account: { connectionProxyEnabled: "true", connectionProxyUrl: "http://legacy.example.test" } },
    { provider: "__direct__", global: "on" }, { provider: "relay" }, { global: "strict" }, { global: "__none__" }, { provider: 7, global: "on" },
    { account: { proxyPoolId: "" }, provider: "", global: "" },
  ];
  return layers.map((l) => {
    const r = routing.resolveProxyChain({ ...l, pools });
    const proxy = r.connectionProxyEnabled && r.connectionProxyUrl ? r.connectionProxyUrl : "";
    return {
      input: l, pools,
      out: {
        layer: r.layer, connectionProxyEnabled: r.connectionProxyEnabled, connectionProxyUrl: r.connectionProxyUrl, connectionNoProxy: r.connectionNoProxy,
        strictProxy: r.strictProxy, vercelRelayUrl: r.vercelRelayUrl, direct: r.direct, blocked: r.blockedReason !== "",
      },
      transport: JSON.stringify([proxy, proxy ? r.connectionNoProxy || "" : "", r.vercelRelayUrl || "", r.direct === true]),
    };
  });
}

// Node's own fetch, before proxyFetch.js patches the global.
const nativeFetch = globalThis.fetch;

// The headers Node's fetch builds for a POST with the executor's headers,
// per target, as its dispatcher receives them: one that sends nothing. Over
// https too, which the local wire server can't show without a certificate.
async function fetchDefaults() {
  const given = [["content-type", "application/json"], ["x-api-key", "key-k1"], ["accept", "text/event-stream"]];
  const out = [];
  for (const url of ["http://upstream.test/v1/messages", "https://upstream.test/v1/messages"]) {
    let seen = null;
    const dispatcher = {
      dispatch(opts, handler) {
        seen = opts.headers;
        handler.onError(new Error("captured"));
        return true;
      },
    };
    await nativeFetch(url, { method: "POST", headers: Object.fromEntries(given), body: new Uint8Array([123, 125]), dispatcher }).catch(() => {});
    const pairs = [];
    if (Array.isArray(seen)) {
      if (Array.isArray(seen[0])) for (const [k, v] of seen) pairs.push([String(k).toLowerCase(), String(v)]);
      else for (let i = 0; i < seen.length; i += 2) pairs.push([String(seen[i]).toLowerCase(), String(seen[i + 1])]);
    } else if (seen) {
      for (const [k, v] of Object.entries(seen)) pairs.push([k.toLowerCase(), String(v)]);
    }
    // The transport adds these, not fetch's header list.
    out.push({ url, given, headers: [...pairs.filter(([k]) => k !== "content-length" && k !== "host"), ["connection", "keep-alive"]] });
  }
  return out;
}

// Where Node's fetch sends a URL: the origin and path its dispatcher gets
// (the host lowercased, a default or zero-padded port normalized), for the
// cases the local server can't show (default ports).
const FETCH_TARGETS = [
  "https://API.Example.test:443/v1/messages", "http://Up.Test:80/v1/messages", "https://up.test:0443/v1/messages?beta=true",
  "http://UP.test:08080/v1/messages", "https://up.test./v1/messages", "https://up.test",
];

async function fetchTargets() {
  const out = [];
  for (const url of FETCH_TARGETS) {
    let seen = null;
    const dispatcher = {
      dispatch(opts, handler) {
        seen = { origin: String(opts.origin), path: opts.path };
        handler.onError(new Error("captured"));
        return true;
      },
    };
    await nativeFetch(url, { method: "POST", body: new Uint8Array([123, 125]), dispatcher }).catch(() => {});
    out.push({ url, ...seen });
  }
  return out;
}

const PROXY_ENVS = [
  {}, { HTTPS_PROXY: "http://proxy.test:1" }, { https_proxy: "http://proxy.test:2" }, { HTTPS_PROXY: "  ", https_proxy: "http://proxy.test:3" },
  { HTTP_PROXY: "http://proxy.test:4" }, { ALL_PROXY: "socks5://proxy.test:5" }, { all_proxy: "http://proxy.test:6", HTTPS_PROXY: "" },
  { HTTPS_PROXY: "http://proxy.test:7", NO_PROXY: "upstream.test" }, { HTTPS_PROXY: "http://proxy.test:8", NO_PROXY: ".upstream.test" },
  { HTTPS_PROXY: "http://proxy.test:9", NO_PROXY: "api.upstream.test" }, { HTTPS_PROXY: "http://proxy.test:10", no_proxy: "*" },
  { HTTPS_PROXY: "http://proxy.test:11", NO_PROXY: " other.test , UPSTREAM.TEST " }, { HTTPS_PROXY: "http://proxy.test:12", NO_PROXY: "pstream.test" },
  { HTTPS_PROXY: "http://proxy.test:13", NO_PROXY: "", no_proxy: "upstream.test" }, { HTTP_PROXY: "http://proxy.test:14", NO_PROXY: ".test" },
];
const PROXY_TARGETS = ["https://api.upstream.test/v1/messages", "http://upstream.test:8080/v1", "https://upstream.test/v1"];

async function envProxyCases() {
  const { getEnvProxyUrl } = await import("../../open-sse/utils/proxyFetch.js");
  const out = [];
  for (const env of PROXY_ENVS) {
    for (const target of PROXY_TARGETS) {
      for (const name of ENV) delete process.env[name];
      Object.assign(process.env, env);
      const proxy = getEnvProxyUrl(target);
      out.push({ env, target, proxy: proxy ?? null });
    }
  }
  for (const name of ENV) delete process.env[name];
  return out;
}

// ── Wire scenarios ───────────────────────────────────────────────────────────

const SSE_OK = [
  ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "m1", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
  ["message_stop", { type: "message_stop" }],
].map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");

const json = (status, value) => ({ status, body: JSON.stringify(value) });
const gz = (text) => [...gzipSync(Buffer.from(text, "utf8"))];
const LIMITED = JSON.stringify({ error: { message: "Rate limit exceeded" } });
const rejected = (...flags) => json(400, { type: "error", error: { type: "invalid_request_error", message: `Unexpected value(s) ${flags.map((f) => `\`${f}\``).join(", ")} for the \`anthropic-beta\` header.` } });
const BETAS = "interleaved-thinking-2025-05-14,context-management-2025-06-27,fine-grained-tool-streaming-2025-05-14";

const WIRE = [
  { name: "a plain stream", script: ["ok"] },
  { name: "a 503 is retried", script: [json(503, { error: { message: "busy" } }), json(503, { error: { message: "busy" } }), "ok"] },
  { name: "a 502 every time", script: [json(502, { error: { message: "bad gateway" } })] },
  { name: "a 429 is not retried", script: [json(429, { error: { message: "Rate limit exceeded" } })] },
  { name: "a rejected beta flag", script: [rejected("interleaved-thinking-2025-05-14"), "ok"] },
  { name: "rejected twice: no flags at all", script: [rejected("interleaved-thinking-2025-05-14"), rejected("context-management-2025-06-27"), "ok"] },
  { name: "a rejected flag that wasn't sent", script: [rejected("unknown-flag-1")] },
  { name: "a retry, then a rejected flag", script: [json(503, { error: { message: "busy" } }), rejected("fine-grained-tool-streaming-2025-05-14"), "ok"] },
  { name: "an empty 404", script: [{ status: 404, body: "" }] },
  { name: "a gzip error body", script: [{ status: 500, body: JSON.stringify({ error: { message: "zipped" } }), gzip: true }] },
  // Fetch inflates with Z_SYNC_FLUSH: a gzip body that ends before its
  // trailer still reads as far as it got.
  { name: "a gzip error body without its trailer", script: [{ status: 429, body: JSON.stringify({ error: { message: "Rate limit exceeded" } }), gzip: true, noTrailer: true }] },
  // zlib reads zero bytes after a gzip member as padding.
  { name: "a zero-padded gzip error body", script: [{ status: 429, body: JSON.stringify({ error: { message: "Rate limit exceeded" } }), gzip: true, padZeros: 16 }] },
  // zlib after a member: a zero byte ends the body whatever follows; any
  // other byte starts the next member, which may end inside its header.
  { name: "zeros, then other bytes, after a gzip member", script: [{ status: 429, gzipBytes: [...gz(LIMITED), 0, 0, ...Buffer.from("junk")] }] },
  { name: "a second gzip member cut inside its header", script: [{ status: 429, gzipBytes: [...gz(LIMITED), 0x1f, 0x8b, 0x08] }] },
  { name: "other bytes after a gzip member", script: [{ status: 429, gzipBytes: [...gz(LIMITED), ...Buffer.from("xyz")] }] },
  { name: "two gzip members", script: [{ status: 429, gzipBytes: [...gz(LIMITED.slice(0, 20)), ...gz(LIMITED.slice(20))] }] },
  { name: "only part of a gzip header", script: [{ status: 500, gzipBytes: [0x1f, 0x8b] }] },
  // FLG's reserved bits: zlib refuses the header.
  { name: "a gzip header with reserved flags", script: [{ status: 429, gzipBytes: ((b) => [b[0], b[1], b[2], b[3] | 0xe0, ...b.slice(4)])(gz(LIMITED)) }] },
  { name: "reserved flags, then the body ends", script: [{ status: 429, gzipBytes: [0x1f, 0x8b, 0x08, 0x20] }] },
  // zlib reads the header in pairs: a body that ends inside one ends cleanly,
  // whatever its byte.
  { name: "one stray byte after a gzip member", script: [{ status: 429, gzipBytes: [...gz(LIMITED), 0x0a] }] },
  { name: "a magic number, then a method zlib doesn't take", script: [{ status: 429, gzipBytes: [...gz(LIMITED), 0x1f, 0x8b, 0x07] }] },
  { name: "a body of one byte", script: [{ status: 500, gzipBytes: [0x1e] }] },
  { name: "two stray bytes after a gzip member", script: [{ status: 429, gzipBytes: [...gz(LIMITED), 0x0a, 0x0a] }] },
  // fetch sends new URL(baseUrl): the host lowercased, the port as a number.
  { name: "a base URL's host case and port", baseHost: "LocalHost", portPad: "0", script: ["ok"] },
  { name: "an error body in broken UTF-8", script: [{ status: 500, bodyBytes: [0x7b, 0xff, 0xfe, 0x78, 0xe2, 0x82, 0x7d] }] },
  { name: "a BOM before the error", script: [{ status: 500, bodyBytes: [0xef, 0xbb, 0xbf, 0x6f, 0x6b] }] },
  // The error body breaks off: text() throws, and chatCore takes "".
  { name: "an error body cut short", script: [{ status: 500, body: "{\"error\":", cut: true }] },
  { name: "no headers in time", script: ["hang"] },
  // The beta retry runs out of time: Node throws, so it saves no flag.
  { name: "a rejected flag, then no headers", script: [rejected("interleaved-thinking-2025-05-14"), "hang"] },
  { name: "learned flags stay off", psd: { droppedBetas: ["interleaved-thinking-2025-05-14"] }, script: [rejected("context-management-2025-06-27"), "ok"] },
  { name: "strip beta sends none", psd: { stripBeta: true }, script: ["ok"] },
];

const CLIENT_HEADERS = { "content-type": "application/json", "user-agent": "claude-cli/2.1.258 (external, cli)", "x-app": "cli", "anthropic-version": "2023-06-01", "anthropic-beta": BETAS };
const BODY = {
  model: "hot/m1", max_tokens: 1024, stream: true,
  system: [{ type: "text", text: "You are a helper." }],
  messages: [{ role: "user", content: [{ type: "text", text: "Explain the build failure in step three." }] }],
  tools: [{ name: "Read", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
};

function startServer(script, seen) {
  let n = 0;
  const hung = [];
  let port = 0;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const headers = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i].toLowerCase();
        // The port is this run's: kept as <port>.
        const value = name === "host" ? req.rawHeaders[i + 1].split(String(port)).join("<port>") : req.rawHeaders[i + 1];
        headers.push([name, value]);
      }
      seen.push({ method: req.method, path: req.url, headers, body: Buffer.concat(chunks).toString("utf8") });
      const step = script[Math.min(n++, script.length - 1)];
      if (step === "hang") { hung.push(res); return; }
      if (step === "ok") { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(SSE_OK); return; }
      if (step.gzipBytes) {
        res.writeHead(step.status, { "content-type": "application/json", "content-encoding": "gzip" });
        res.end(Buffer.from(step.gzipBytes));
        return;
      }
      let body = step.bodyBytes ? Buffer.from(step.bodyBytes) : Buffer.from(step.body, "utf8");
      const headers2 = { "content-type": "application/json" };
      if (step.cut) {
        // Promise more than is sent, then drop the connection.
        res.writeHead(step.status, { ...headers2, "content-length": String(body.length + 100) });
        res.write(body, () => res.socket.destroy());
        return;
      }
      if (step.gzip) { body = gzipSync(body); headers2["content-encoding"] = "gzip"; }
      if (step.noTrailer) body = body.subarray(0, body.length - 8);
      if (step.padZeros) body = Buffer.concat([body, Buffer.alloc(step.padZeros)]);
      res.writeHead(step.status, headers2);
      res.end(body);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    port = server.address().port;
    resolve({ server, port, hung });
  }));
}

function installSleepShim() {
  const real = globalThis.setTimeout;
  globalThis.setTimeout = function (fn, ms, ...args) {
    const caller = (new Error().stack || "").split("\n")[2] || "";
    if (caller.includes("executors/base.js") && ms > 0) {
      world.events.push({ sleep: ms });
      return real(fn, 0, ...args);
    }
    return real(fn, ms, ...args);
  };
  return () => { globalThis.setTimeout = real; };
}

// The wire scenarios' environment. Set before the first import of the
// executor: the mocked chatCore keeps the modules it first loaded, so a
// later change wouldn't reach them.
const WIRE_ENV = { UPSTREAM_STREAM_HEADERS_TIMEOUT_MS: "1500" };

async function runWire(scenario, dir) {
  delete global._authEvents;
  // modelHang.js is mocked: its first instance keeps the map it took from
  // global, so the map is emptied rather than replaced.
  global._modelHang?.clear();
  delete global._selectionMutexes;
  const seen = [];
  const { server, port, hung } = await startServer(scenario.script, seen);
  const restore = installSleepShim();
  const base = `http://${scenario.baseHost || "127.0.0.1"}:${scenario.portPad || ""}${port}/v1`;
  try {
    const { adapter, repos } = await openRepos("sql.js", dir);
    await repos.updateSettings({ requireApiKey: false });
    const now = new Date().toISOString();
    adapter.run(`INSERT INTO providerNodes(id, type, name, data, createdAt, updatedAt) VALUES(?, 'openai-compatible', 'hot', ?, ?, ?)`,
      [PROVIDER, JSON.stringify({ prefix: "hot", apiType: "chat", baseUrl: base }), now, now]);
    const psd = { apiType: "chat", baseUrl: base, modelRoutes: { m1: "anthropic" }, ...(scenario.psd || {}) };
    adapter.run(`INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES('k1', ?, 'apikey', 'k1', NULL, 1, 1, ?, ?, ?)`,
      [PROVIDER, JSON.stringify({ apiKey: "key-k1", providerSpecificData: psd }), now, now]);
    const { handleChat } = await import("../../src/sse/handlers/chat.ts");
    world.events = [];
    const res = await handleChat(new Request("http://localhost:20128/v1/messages", { method: "POST", headers: CLIENT_HEADERS, body: JSON.stringify(BODY) }));
    await res.text();
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    const conn = JSON.parse(adapter.get(`SELECT data FROM providerConnections WHERE id = 'k1'`).data);
    const node = JSON.parse(adapter.get(`SELECT data FROM providerNodes WHERE id = ?`, [PROVIDER]).data);
    const strip = (s) => s.split(base).join("<base>");
    return {
      name: scenario.name, env: WIRE_ENV, script: scenario.script,
      baseHost: scenario.baseHost || "127.0.0.1", portPad: scenario.portPad || "",
      provider: PROVIDER, clientHeaders: CLIENT_HEADERS, clientBody: JSON.stringify(BODY),
      psd: JSON.parse(strip(JSON.stringify(psd))),
      requests: seen.map((r) => ({ ...r, body: strip(r.body) })),
      events: world.events,
      savedBetas: { connection: conn.providerSpecificData?.droppedBetas ?? null, node: node.droppedBetas ?? null },
    };
  } finally {
    restore();
    for (const r of hung) r.destroy();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    closeRepos();
  }
}

const dirs = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("sender fixtures for the Go gateway", () => {
  it("keeps the table export the Go port embeds", async () => {
    const text = await tablesText();
    if (RECORD) writeFileSync(`${DIR}tables.json`, text);
    expect(readFileSync(`${DIR}tables.json`, "utf8"), "regenerate with UPSTREAM_RECORD=1").toBe(text);
  });

  it("keeps the budget, beta and proxy vectors", async () => {
    const budgets = await budgetCases();
    const { parseRejectedBetas } = await import("../../open-sse/utils/anthropicBeta.ts");
    const routing = await import("../../src/lib/network/proxyRouting.ts");
    const text = JSON.stringify({
      budgets,
      rejections: REJECTIONS.map((t) => ({ text: t, flags: parseRejectedBetas(t) })),
      proxies: proxyCases(routing),
      fetchDefaults: await fetchDefaults(),
      fetchTargets: await fetchTargets(),
      envProxies: await envProxyCases(),
    }, null, 1) + "\n";
    if (RECORD) writeFileSync(`${DIR}testdata/vectors.json`, text);
    expect(readFileSync(`${DIR}testdata/vectors.json`, "utf8"), "Node's sender rules changed: regenerate with UPSTREAM_RECORD=1 and update gateway/internal/upstream").toBe(text);
  });

  it("keeps the wire scenarios", async () => {
    Object.assign(process.env, WIRE_ENV);
    vi.resetModules();
    const out = [];
    try {
      for (const scenario of WIRE) {
        const dir = tempDataDir("gateway-upstream-");
        dirs.push(dir);
        const recorded = await runWire(scenario, dir);
        expect(recorded.requests.length, `${scenario.name}: nothing reached the server`).toBeGreaterThan(0);
        out.push(recorded);
      }
    } finally {
      for (const k of Object.keys(WIRE_ENV)) delete process.env[k];
    }
    const text = JSON.stringify(out, null, 1) + "\n";
    if (RECORD) writeFileSync(`${DIR}testdata/wire.json`, text);
    expect(readFileSync(`${DIR}testdata/wire.json`, "utf8"), "Node's sends changed: regenerate with UPSTREAM_RECORD=1 and update gateway/internal/upstream").toBe(text);
  }, 120000);
});
