// Golden fixtures for the Go gateway's account selection and per-key state
// (gateway/internal/accounts, docs/GO_GATEWAY.md "Phase 2c").
//
// Three files, all recorded from Node's real code:
//  - tables.json: the rule tables the Go port embeds (ERROR_RULES, backoff,
//    limit and account texts, the same-request patterns, HEADERS_TIMEOUT,
//    CACHE_AFFINITY, ...), never restated in Go.
//  - testdata/vectors.json: the pure rules on many inputs: checkFallbackError,
//    isRequestError, isLimitError, the same-request signatures, the
//    cache-affinity key and prompt estimate, the failure summary,
//    allLockedError, formatRetryAfter, connectionUpstream, and model hang.
//  - testdata/scenarios.json: getProviderCredentials, markAccountUnavailable
//    and clearAccountError driven step by step over a real database (sql.js)
//    on a fixed clock, with every connection row after each step. The Go test
//    replays the steps on the same rows through its own readers and writers.
//
// Without ACCOUNTS_RECORD this checks that Node still makes the committed
// files. With ACCOUNTS_RECORD=1 it writes them.
import { describe, it, expect, vi, afterAll } from "vitest";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { closeRepos, openRepos, tempDataDir } from "../helpers/nodeDb.js";

for (const name of ["CACHE_AFFINITY_TTL_MS", "CACHE_AFFINITY_MAX_WAIT_MS", "CACHE_AFFINITY_MIN_TOKENS", "SAME_REQUEST_ERROR_STOP_AFTER", "UPSTREAM_STREAM_HEADERS_TIMEOUT_MS", "FETCH_CONNECT_TIMEOUT_MS"]) delete process.env[name];

const DIR = fileURLToPath(new URL("../../gateway/internal/accounts/", import.meta.url));
const RECORD = process.env.ACCOUNTS_RECORD === "1";
const T0 = Date.parse("2026-03-01T12:00:00.000Z");
const PROVIDER = "openai-compatible-chat-hot";

const errorConfig = await import("../../open-sse/config/errorConfig.js");
const runtime = await import("../../open-sse/config/runtimeConfig.js");
const appConstants = await import("../../open-sse/config/appConstants.js");
const fallback = await import("../../open-sse/services/accountFallback.js");
const limitHold = await import("../../open-sse/utils/limitHold.js");
const sameRequest = await import("../../open-sse/services/sameRequestError.ts");
const affinity = await import("../../open-sse/services/cacheAffinity.js");
const hang = await import("../../open-sse/services/modelHang.js");
const summary = await import("../../src/sse/services/accountFailureSummary.js");
const upstream = await import("../../src/sse/services/connectionUpstream.ts");

const re = (r) => ({ source: r.source, flags: r.flags });

function tablesText() {
  return JSON.stringify({
    errorRules: errorConfig.ERROR_RULES.map((r) => ({ text: r.text || "", status: r.status || 0, cooldownMs: r.cooldownMs || 0, backoff: r.backoff === true })),
    backoff: { Base: errorConfig.BACKOFF_CONFIG.base, Max: errorConfig.BACKOFF_CONFIG.max, MaxLevel: errorConfig.BACKOFF_CONFIG.maxLevel },
    transientCooldownMs: errorConfig.TRANSIENT_COOLDOWN_MS,
    maxRateLimitCooldownMs: errorConfig.MAX_RATE_LIMIT_COOLDOWN_MS,
    badKeyTexts: errorConfig.BAD_KEY_TEXTS,
    billingTexts: errorConfig.BILLING_TEXTS,
    limitErrorTexts: limitHold.LIMIT_ERROR_TEXTS,
    requestErrorStatuses: [...fallback.REQUEST_ERROR_STATUSES],
    headersTimeout: errorConfig.HEADERS_TIMEOUT,
    cacheAffinity: runtime.CACHE_AFFINITY,
    affinityProviders: [...appConstants.AFFINITY_PROVIDERS],
    inlineMedia: { ...appConstants.INLINE_MEDIA, dataUri: re(appConstants.INLINE_MEDIA.dataUri) },
    sessionHeaderKeys: appConstants.SESSION_HEADER_KEYS,
    sameRequestError: {
      stopAfter: runtime.SAME_REQUEST_ERROR_STOP_AFTER,
      statuses: [...runtime.SAME_REQUEST_ERROR_STATUSES],
      limitPatterns: errorConfig.SAME_REQUEST_ERROR_LIMIT_PATTERNS.map(re),
      shapePatterns: errorConfig.SAME_REQUEST_ERROR_SHAPE_PATTERNS.map(re),
      keyLimit: re(errorConfig.SAME_REQUEST_ERROR_KEY_LIMIT),
      maxText: errorConfig.SAME_REQUEST_ERROR_MAX_TEXT,
    },
    modelRefusal: re(errorConfig.MODEL_REFUSAL),
    operationRefusal: re(errorConfig.OPERATION_REFUSAL),
    upstreamStreamHeadersTimeoutMs: runtime.UPSTREAM_STREAM_HEADERS_TIMEOUT_MS,
    defaultErrorMessages: errorConfig.DEFAULT_ERROR_MESSAGES,
    errorTypes: errorConfig.ERROR_TYPES,
  }, null, 2) + "\n";
}

// ── Vectors ──────────────────────────────────────────────────────────────────

const ERROR_TEXTS = [
  "", "[429]: Rate limit exceeded", "[429]: too many requests, slow down", "[400]: Quota exceeded for this key",
  "[503]: The model is overloaded", "[503]: Service unavailable", "[502]: Bad gateway", "[500]: capacity reached",
  "[401]: Invalid API key", "[401]: api key not valid", "[400]: invalid_api_key", "[400]: Your credit balance is too low",
  "[404]: model not found", "[403]: Request not allowed", "[400]: improperly formed request", "[400]: no credentials",
  "[400]: prompt is too long: 250000 tokens > 200000 maximum", "[400]: input_schema is invalid for tools.3",
  "[400]: {\"error\":{\"message\":\"maximum context length is 200000 tokens, you requested 250000 tokens\"}}",
  "[400]: maximum context length exceeded (request id: 20260301abc)", "[413]: Request entity too large",
  "[413]: request too large on tokens per min (TPM)", "[422]: budget_tokens must be less than max_tokens",
  "[400]: The model claude-x does not have access to model claude-x", "[400]: Missing scopes: model.request",
  "[504]: upstream sent no response headers in 240s (headers timeout, set by UPSTREAM_STREAM_HEADERS_TIMEOUT_MS)",
  "[429]: RESOURCE_EXHAUSTED: usage_limit_reached", "[400]: Upgrade your plan for longer context",
  "[400]: context window exceeded\r\nretry later", "[400]: INPUT TOKENS EXCEED the limit of 100000 vs 200000",
  "[400]:    spaced   message   with   1234   and   56789", "[400]: 请求过长 maximum context length 1000000 > 800000",
  "[400]: premium request quota", "[418]: teapot",
];
const STATUSES = [400, 401, 402, 403, 404, 413, 418, 422, 429, 500, 502, 503, 504];

function vectors() {
  const fallbackCases = [];
  for (const status of STATUSES) for (const text of ERROR_TEXTS) for (const level of [0, 3, 15]) {
    fallbackCases.push({ status, text, level, out: fallback.checkFallbackError(status, text, level) });
  }
  const textCases = [];
  for (const status of STATUSES) for (const text of ERROR_TEXTS) {
    const sig = sameRequest.requestErrorSignatures(status, text);
    textCases.push({
      status, text,
      requestError: fallback.isRequestError(status, text),
      limitError: limitHold.isLimitError(status, text),
      headersTimeout: fallback.isHeadersTimeout(status, text),
      namesAccountOrLimit: fallback.namesAccountOrLimit(text),
      requestFault: sameRequest.isRequestFault(status, text),
      signature: sig,
      upstreamMessage: sameRequest.upstreamMessage(text),
      normalized: sameRequest.normalizeErrorMessage(text),
    });
  }
  const text = (t) => ({ type: "text", text: t });
  const cached = (t) => ({ type: "text", text: t, cache_control: { type: "ephemeral" } });
  const bodies = [
    { messages: [{ role: "user", content: "hi" }] },
    { system: [cached("You are a helper")], messages: [{ role: "user", content: "hi" }] },
    { system: [cached("x-anthropic-billing-header: cc_version=1; cch=abc;\nYou are a helper")], messages: [{ role: "user", content: [text("hi")] }] },
    { system: [cached("x-anthropic-billing-header: cc_version=2; cch=def;\nYou are a helper")], messages: [{ role: "user", content: [text("hi")] }] },
    { system: "s", messages: [{ role: "system", content: "a" }, { role: "developer", content: "b" }, { role: "user", content: [cached("hello")] }, { role: "assistant", content: "x" }] },
    { system: [{ type: "text", text: "s", cache_control: { type: "ephemeral", ttl: "1h" } }], messages: [{ role: "user", content: "q" }] },
    { prompt_cache_key: "conv-1", messages: [{ role: "user", content: "q" }] },
    { prompt_cache_key: "  conv-2  ", messages: [{ role: "user", content: "q" }], metadata: { user_id: "user_abc_account__session_1234-abcd" } },
    { system: [cached("s")], messages: [{ role: "user", content: "q" }], metadata: { user_id: "{\"device_id\":\"d\",\"session_id\":\"s-42\"}" } },
    { system: [cached("s")], messages: [{ role: "user", content: "q" }], session_id: "sess", conversation_id: "conv" },
    { system: [cached("s")], messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(4000) } }, text("look 😀")] }] },
    { system: [cached("s")], instructions: "do it", messages: [] },
    { tools: [{ name: "t", cache_control: { type: "ephemeral" }, input_schema: { type: "object" } }], messages: [{ role: "user", content: "data:image/png;base64,AAAA" }] },
  ];
  const headerSets = [{}, { "x-claude-code-session-id": " hdr-session " }, { "x-session-id": "s1", "user-agent": "claude-cli/2.1" }];
  const affinityCases = [];
  for (const body of bodies) for (const headers of headerSets) for (const tenant of ["", "sk-tenant"]) {
    affinityCases.push({
      body, headers, tenant,
      key: affinity.cacheAffinityKey({ provider: PROVIDER, model: "m", body, headers, tenant: tenant || null }),
    });
  }
  const bodyCases = bodies.map((body) => ({ body, usesCache: affinity.requestUsesPromptCache(body), ttlMs: affinity.cacheTtlMs(body), tokens: affinity.estimatePromptTokens(body) }));
  const failuresSets = [
    [],
    [{ account: "k1", status: 429, error: "[429]: Rate limit exceeded" }],
    [{ account: "k1", status: 503, error: "[503]: {\"error\":{\"message\":\"overloaded\"}}" }, { account: "", status: 0, error: "x" }],
    [{ account: "k1", status: 401, error: "[401]: bad" }, { account: "k2", status: 400, error: "[400]: invalid request" }],
    [{ account: "k1", status: 404, error: "[404]: no model" }, { account: "k2", status: 422, error: "[422]: bad body" }],
  ];
  const summaryCases = failuresSets.map((failures) => ({ failures, out: summary.summarizeAccountFailures(PROVIDER, "m", failures) }));
  const lockedCases = [];
  const credsSets = [null, { lastErrorCode: 429, lastError: "[429]: limited", lastErrorOwn: true }, { lastErrorCode: 503, lastError: null, lastErrorOwn: false }, { lastErrorCode: null, lastError: "[401]: x", lastErrorOwn: true }];
  for (const lastStatus of [null, 401, 403, 404, 429, 500]) for (const lastError of [null, "[x]: last"]) for (const creds of credsSets) for (const failures of failuresSets) {
    lockedCases.push({ lastStatus, lastError, creds, failures, out: limitHold.allLockedError(lastStatus, lastError, creds, failures) });
  }
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  const retryCases = [-1000, 0, 1, 999, 1000, 1001, 59000, 61000, 3600000, 3661000, 7322500].map((d) => ({ untilMs: T0 + d, out: fallback.formatRetryAfter(new Date(T0 + d).toISOString()) }));
  const upstreamCases = [
    {}, { baseUrl: "https://API.Example.test:443/v1/" }, { baseUrl: "http://h.example.test:80/v1/messages?x=1" }, { baseUrl: " https://h.example.test/v1/chat/completions/ " },
    { baseUrl: "not a url" }, { baseUrl: "https://h.example.test/v1", region: "eu/", accountId: 7 }, { azureEndpoint: "https://a.example.test/", projectId: "p" },
  ].map((psd) => ({ psd, out: upstream.connectionUpstream({ providerSpecificData: psd }) }));
  // Model hang: one sequence of calls on a fixed clock.
  hang.clearModelHang();
  const hangSteps = [];
  const call = (step) => {
    vi.setSystemTime(step.at);
    let out;
    if (step.op === "check") out = hang.checkModelHang(PROVIDER, "m", step.requestId);
    if (step.op === "timeout") out = hang.noteHeadersTimeout(PROVIDER, "m", { requestId: step.requestId, connectionId: step.connectionId, stream: step.stream, reason: step.reason });
    if (step.op === "budget") out = hang.noteProbeBudget(PROVIDER, "m", step.requestId, step.budgetMs) ?? null;
    if (step.op === "served") out = hang.noteModelServed(PROVIDER, "m") ?? null;
    if (step.op === "release") out = hang.releaseProbe(PROVIDER, "m", step.requestId) ?? null;
    if (out && Array.isArray(out.avoidKeys)) out = { ...out, avoidKeys: [...out.avoidKeys].sort() };
    hangSteps.push({ ...step, out });
  };
  const m = 60 * 1000;
  for (const step of [
    { op: "check", at: T0, requestId: "r1" },
    { op: "timeout", at: T0 + 1000, requestId: "r1", connectionId: "k1", stream: true, reason: "no headers" },
    { op: "timeout", at: T0 + 2000, requestId: "r1", connectionId: "k2", stream: false, reason: "" },
    { op: "check", at: T0 + 3000, requestId: "r2" },
    { op: "timeout", at: T0 + 4000, requestId: "r2", connectionId: "k2", stream: true, reason: "" },
    { op: "check", at: T0 + 5000, requestId: "r3" },
    { op: "check", at: T0 + 2 * m + 5000, requestId: "r4" },
    { op: "check", at: T0 + 2 * m + 6000, requestId: "r5" },
    { op: "budget", at: T0 + 2 * m + 7000, requestId: "r4", budgetMs: 30000 },
    { op: "check", at: T0 + 2 * m + 8000, requestId: "r6" },
    { op: "timeout", at: T0 + 2 * m + 9000, requestId: "r4", connectionId: "k3", stream: true, reason: "again" },
    { op: "check", at: T0 + 8 * m, requestId: "r7" },
    { op: "release", at: T0 + 8 * m + 1, requestId: "r7" },
    { op: "check", at: T0 + 8 * m + 2, requestId: "r8" },
    { op: "served", at: T0 + 8 * m + 3 },
    { op: "check", at: T0 + 8 * m + 4, requestId: "r9" },
    { op: "timeout", at: T0 + 70 * m, requestId: "r9", connectionId: "k1", stream: true, reason: "late" },
    { op: "check", at: T0 + 70 * m + 1, requestId: "r10" },
  ]) call(step);
  vi.useRealTimers();
  return { fallbackCases, textCases, affinityCases, bodyCases, summaryCases, lockedCases, retryCases, upstreamCases, nowMs: T0, hangSteps };
}

// ── Scenarios ────────────────────────────────────────────────────────────────

const conn = (id, priority, data = {}) => ({ id, priority, data: { apiKey: `key-${id}`, providerSpecificData: { baseUrl: "https://up.example.test/v1" }, ...data } });
const iso = (ms) => new Date(ms).toISOString();
const S = 1000;
const RL = "[429]: Rate limit exceeded";

const SCENARIOS = [
  {
    name: "fill-first fallback and recovery",
    connections: [conn("k1", 1), conn("k2", 2), conn("k3", 3)],
    steps: [
      { op: "select", model: "m" },
      { op: "fail", id: "k1", status: 429, error: RL, model: "m" },
      { op: "select", model: "m", exclude: ["k1"] },
      { op: "succeed", id: "k2", model: "m" },
      { op: "select", model: "m" },
      { op: "advance", ms: 3 * S },
      { op: "select", model: "m" },
      { op: "succeed", id: "k1", model: "m" },
      { op: "succeed", id: "k1", model: "m" },
    ],
  },
  {
    name: "backoff escalates and a straggler keeps the lock",
    connections: [conn("k1", 1), conn("k2", 2)],
    steps: [
      { op: "fail", id: "k1", status: 429, error: RL, model: "m" },
      { op: "advance", ms: 500 },
      { op: "fail", id: "k1", status: 429, error: RL, model: "m" },
      { op: "advance", ms: 3 * S },
      { op: "fail", id: "k1", status: 429, error: "[429]: too many requests", model: "m" },
      { op: "advance", ms: 10 * S },
      { op: "fail", id: "k1", status: 503, error: "[503]: overloaded", model: "m" },
      { op: "fail", id: "k2", status: 504, error: "[504]: upstream sent no response headers in 240s (headers timeout, set by UPSTREAM_STREAM_HEADERS_TIMEOUT_MS)", model: "m" },
      { op: "fail", id: "k2", status: 504, error: "[504]: upstream sent no response headers in 240s (headers timeout, set by UPSTREAM_STREAM_HEADERS_TIMEOUT_MS)", model: "m" },
      { op: "select", model: "m" },
      { op: "select", model: "other" },
      { op: "advance", ms: 60 * S },
      { op: "select", model: "m" },
      { op: "succeed", id: "k1", model: "m" },
    ],
  },
  {
    name: "every key locked",
    connections: [conn("k1", 1), conn("k2", 2), conn("k3", 3)],
    steps: [
      { op: "fail", id: "k1", status: 429, error: RL, model: "m" },
      { op: "fail", id: "k2", status: 500, error: "[500]: Internal error", model: "m" },
      { op: "fail", id: "k3", status: 404, error: "[404]: not found", model: "m" },
      { op: "select", model: "m" },
      { op: "select", model: "m", exclude: ["k1", "k2", "k3"] },
      { op: "fail", id: "k1", status: 400, error: "[400]: Rate limit hit", model: "" },
      { op: "select", model: "n" },
      { op: "fail", id: "k2", status: 429, error: RL, model: "m", resetsAtMs: T0 + 90 * S },
      { op: "fail", id: "k3", status: 429, error: RL, model: "m", resetsAtMs: T0 + 3 * 3600 * S },
      { op: "select", model: "m" },
      { op: "advance", ms: 31 * S },
      { op: "select", model: "m" },
    ],
  },
  {
    name: "status and text rules",
    connections: [conn("k1", 1)],
    steps: [
      { op: "fail", id: "k1", status: 418, error: "[418]: teapot", model: "a" },
      { op: "fail", id: "k1", status: 403, error: "[403]: Request not allowed", model: "b" },
      { op: "fail", id: "k1", status: 402, error: "[402]: pay", model: "c" },
      { op: "fail", id: "k1", status: 400, error: "[400]: improperly formed request", model: "d" },
      { op: "fail", id: "k1", status: 500, error: "x".repeat(150) + "😀", model: "e" },
      { op: "fail", id: "k1", status: 500, error: "y".repeat(99) + "😀z", model: "f" },
      { op: "select", model: "a" },
      { op: "advance", ms: 200 * S },
      { op: "select", model: "z" },
      { op: "succeed", id: "k1", model: "z" },
    ],
  },
  {
    name: "round-robin stickiness",
    settings: { fallbackStrategy: "round-robin", stickyRoundRobinLimit: 2 },
    connections: [conn("k1", 1), conn("k2", 2), conn("k3", 3, { lastUsedAt: iso(T0 - 60 * S), consecutiveUseCount: 5 })],
    steps: [
      { op: "select", model: "m" }, { op: "advance", ms: 10 },
      { op: "select", model: "m" }, { op: "advance", ms: 10 },
      { op: "select", model: "m" }, { op: "advance", ms: 10 },
      { op: "select", model: "m" }, { op: "advance", ms: 10 },
      { op: "fail", id: "k2", status: 429, error: RL, model: "m" },
      { op: "select", model: "m" }, { op: "advance", ms: 10 },
      { op: "select", model: "m", warm: ["k3", "k1"] },
      { op: "select", model: "m", warm: ["k2"], maxWarmWaitMs: 10 * S },
    ],
  },
  {
    name: "provider strategy and global sticky",
    settings: { fallbackStrategy: "fill-first", stickyRoundRobinLimit: 1, providerStrategies: { [PROVIDER]: { fallbackStrategy: "round-robin" } } },
    connections: [conn("k1", 2), conn("k2", 1)],
    steps: [{ op: "select", model: "m" }, { op: "advance", ms: 5 }, { op: "select", model: "m" }, { op: "advance", ms: 5 }, { op: "select", model: "m" }],
  },
  {
    name: "warm key wait",
    connections: [conn("k2", 1), conn("k1", 2), conn("k3", 3)],
    steps: [
      { op: "select", model: "m", warm: ["k1"], maxWarmWaitMs: 10 * S },
      { op: "fail", id: "k2", status: 429, error: RL, model: "m" },
      { op: "select", model: "m", warm: ["k2"], maxWarmWaitMs: 10 * S },
      { op: "select", model: "m", warm: ["k2"], maxWarmWaitMs: 1 * S },
      { op: "select", model: "m", warm: ["k2"], maxWarmWaitMs: 10 * S, avoid: ["k2"] },
      { op: "select", model: "m", warm: ["k2", "k3"], maxWarmWaitMs: 10 * S },
      { op: "fail", id: "k2", status: 500, error: "[500]: boom", model: "m" },
      { op: "select", model: "m", warm: ["k2"], maxWarmWaitMs: 60 * S },
      { op: "select", model: "m", avoid: ["k1"] },
      { op: "select", model: "m", avoid: ["k1", "k3"], exclude: [] },
    ],
  },
  {
    name: "clearing an auth streak and stale flags",
    connections: [
      conn("k1", 1, { authFailCount: 3, authFailFirstAt: iso(T0 - 100 * S), authFailModels: ["m"], testStatus: "unavailable", lastError: "[401]: x", errorCode: 401,
        modelLock_old: iso(T0 - 5 * S), modelLimit_old: true, providerReset_gone: iso(T0 - 1), modelLock_gone: null, modelNoHeaders_m: true, modelLock_m: null, backoffLevel: 4 }),
      conn("k2", 2, { modelLock_m: iso(T0 + 50 * S), modelLock_x: iso(T0 + 50 * S), testStatus: "unavailable", lastError: "[429]: limited", errorCode: 429 }),
    ],
    steps: [
      { op: "select", model: "m" },
      { op: "succeed", id: "k1", model: "m" },
      { op: "select", model: "x" },
      { op: "succeed", id: "k1", model: "x" },
      { op: "fail", id: "k2", status: 429, error: RL, model: "m" },
      { op: "advance", ms: 60 * S },
      { op: "select", model: "m", exclude: ["k1"] },
      { op: "succeed", id: "k2", model: "m" },
    ],
  },
  {
    name: "a demotion record goes to Node",
    goDeclines: "demotion",
    connections: [conn("k1", 1, { "authDemote_m": { count: 5, firstAt: iso(T0 - 3600 * S), demotedAt: iso(T0 - 60 * S), nextProbeAt: iso(T0 + 3600 * S) } }), conn("k2", 2)],
    steps: [{ op: "select", model: "m" }],
  },
];

async function runScenario(scenario, dir) {
  delete global._authEvents;
  const { adapter, repos } = await openRepos("sql.js", dir);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  try {
    if (scenario.settings) await repos.updateSettings(scenario.settings);
    for (const c of scenario.connections) {
      adapter.run(
        `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES(?, ?, 'apikey', ?, NULL, ?, 1, ?, ?, ?)`,
        [c.id, PROVIDER, c.id, c.priority, JSON.stringify(c.data), iso(T0 - 3600 * S), iso(T0 - 3600 * S)],
      );
    }
    const auth = await import("../../src/sse/services/auth.js");
    const rows = () => adapter.all(`SELECT id, isActive, data, updatedAt FROM providerConnections ORDER BY rowid`);
    const initial = adapter.all(`SELECT * FROM providerConnections ORDER BY rowid`);
    const settingsRow = adapter.get(`SELECT data FROM settings WHERE id = 1`)?.data ?? null;
    const lastCreds = {};
    const steps = [];
    for (const step of scenario.steps) {
      let out = null;
      if (step.op === "advance") vi.setSystemTime(Date.now() + step.ms);
      if (step.op === "select") {
        const creds = await auth.getProviderCredentials(PROVIDER, new Set(step.exclude || []), step.model, {
          warmConnectionIds: step.warm || [], maxWarmWaitMs: step.maxWarmWaitMs || 0, avoidConnectionIds: step.avoid || [],
        });
        if (!creds) out = { none: true };
        else if (creds.warmRetryAtMs) out = { warmRetryAtMs: creds.warmRetryAtMs };
        else if (creds.allRateLimited) {
          out = {
            allRateLimited: true, allLimitsExhausted: creds.allLimitsExhausted, retryAfter: creds.retryAfter, retryAfterHuman: creds.retryAfterHuman,
            providerResetAtMs: creds.providerResetAtMs ?? null, lastError: creds.lastError ?? null, lastErrorCode: creds.lastErrorCode ?? null, lastErrorOwn: creds.lastErrorOwn,
          };
        } else {
          lastCreds[creds.connectionId] = creds;
          out = { connectionId: creds.connectionId, connectionName: creds.connectionName };
        }
      }
      if (step.op === "fail") {
        out = await auth.markAccountUnavailable(step.id, step.status, step.error, PROVIDER, step.model || null, step.resetsAtMs ?? null, `key-${step.id}`);
      }
      if (step.op === "succeed") await auth.clearAccountError(step.id, lastCreds[step.id], step.model || null);
      steps.push({ ...step, nowMs: Date.now(), out, rows: rows() });
    }
    return { name: scenario.name, goDeclines: scenario.goDeclines || "", startMs: T0, settings: settingsRow, initial, steps };
  } finally {
    vi.restoreAllMocks();
    vi.useRealTimers();
    closeRepos();
  }
}

const dirs = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("account fixtures for the Go gateway", () => {
  it("keeps the table export the Go port embeds", () => {
    const text = tablesText();
    if (RECORD) writeFileSync(`${DIR}tables.json`, text);
    expect(readFileSync(`${DIR}tables.json`, "utf8"), "regenerate with ACCOUNTS_RECORD=1").toBe(text);
  });

  it("keeps the rule vectors", () => {
    const text = JSON.stringify(vectors(), null, 1) + "\n";
    if (RECORD) writeFileSync(`${DIR}testdata/vectors.json`, text);
    expect(readFileSync(`${DIR}testdata/vectors.json`, "utf8"), "Node's account rules changed: regenerate with ACCOUNTS_RECORD=1 and update gateway/internal/accounts").toBe(text);
  });

  it("keeps the selection, lock and clear scenarios", async () => {
    const out = [];
    for (const scenario of SCENARIOS) {
      const dir = tempDataDir("gateway-accounts-");
      dirs.push(dir);
      out.push(await runScenario(scenario, dir));
    }
    const text = JSON.stringify(out, null, 1) + "\n";
    if (RECORD) writeFileSync(`${DIR}testdata/scenarios.json`, text);
    expect(readFileSync(`${DIR}testdata/scenarios.json`, "utf8"), "Node's account selection changed: regenerate with ACCOUNTS_RECORD=1 and update gateway/internal/accounts").toBe(text);
  });
});
