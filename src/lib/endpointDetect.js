// Endpoint detection for "Add endpoint": paste a URL + key, work out the protocol,
// base URL, models and auth, using FREE requests only. Nothing here may trigger a
// billed generation: chat probes send an empty `messages` array, which every API
// we know rejects with a 400 before running a model.
//
// Results are tri-state. Every probe is recorded in `steps` (status + the first
// part of the body, key redacted) so the user can see why we concluded anything.

const PROBE_TIMEOUT_MS = 8000;
const BODY_PREVIEW = 300;

// Paths users paste that aren't part of the base URL.
const TRAILING_PATHS = ["/chat/completions", "/messages", "/responses", "/models", "/embeddings", "/completions"];

// Cut a pasted URL down to its base. Keeps query params (Azure api-version).
export function normalizeUrl(raw) {
  let s = String(raw || "").trim().replace(/^["'<]+|["'>]+$/g, "");
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = (/^(localhost|127\.|\[::1\])/i.test(s) ? "http://" : "https://") + s;
  let url;
  try { url = new URL(s); } catch { return null; }
  let path = url.pathname.replace(/\/+$/, "");
  for (let changed = true; changed;) {
    changed = false;
    for (const p of TRAILING_PATHS) {
      if (path.toLowerCase().endsWith(p)) { path = path.slice(0, -p.length).replace(/\/+$/, ""); changed = true; }
    }
  }
  return `${url.origin}${path}${url.search}`;
}

// Strip what people paste around a key.
export function cleanKey(raw) {
  return String(raw || "").trim().replace(/^["']|["']$/g, "").replace(/^Bearer\s+/i, "").replace(/\s+/g, "");
}

// Candidate bases to probe: as given, plus `/v1` when the user stopped short of it.
export function candidateBases(base) {
  const out = [base];
  const u = new URL(base);
  if (!/\/v\d+(beta)?$/i.test(u.pathname)) out.push(`${u.origin}${u.pathname.replace(/\/+$/, "")}/v1${u.search}`);
  return out;
}

// Every model-list shape we've seen. Returns ids, deduped, in order.
export function parseModelList(json) {
  const arr = Array.isArray(json) ? json
    : Array.isArray(json?.data) ? json.data
    : Array.isArray(json?.models) ? json.models
    : Array.isArray(json?.result) ? json.result
    : null;
  if (!arr) return [];
  const ids = arr.map((m) => typeof m === "string" ? m : (m?.id || m?.name || m?.model || ""))
    .map((id) => String(id).replace(/^models\//, "").trim())
    .filter(Boolean);
  return [...new Set(ids)];
}

// Name, prefix and icon from the host. Prefix: initials of a multi-part name,
// else its first 4 letters; [a-z0-9] only.
const HOST_SKIP = new Set(["api", "gateway", "llm", "ai", "www", "inference", "openai", "v1", "app"]);
const TLDS = new Set(["com", "net", "org", "io", "ai", "dev", "co", "app", "cloud", "xyz", "sh", "me", "tech"]);
export function suggestName(base) {
  const { hostname } = new URL(base);
  if (/^(localhost|127\.|\d+\.\d+\.\d+\.\d+$|\[)/.test(hostname)) return "Local endpoint";
  const parts = hostname.split(".").filter((p) => !HOST_SKIP.has(p));
  const label = [...parts].reverse().find((p, i) => !(i === 0 && TLDS.has(p))) || parts[0] || hostname;
  const brand = label.replace(/computing$/, "").replace(/-.*$/, "");
  return brand.charAt(0).toUpperCase() + brand.slice(1);
}
export function makePrefix(name, taken = []) {
  const words = String(name || "").replace(/([a-z])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean);
  let p = (words.length > 1 ? words.map((w) => w[0]).join("") : (words[0] || "ep").slice(0, 4)).toLowerCase().replace(/[^a-z0-9]/g, "") || "ep";
  const used = new Set(taken.map((t) => String(t).toLowerCase()));
  if (!used.has(p)) return p;
  for (let i = 2; ; i++) if (!used.has(`${p}${i}`)) return `${p}${i}`;
}

// Endpoints with no model list (Snowflake Cortex: /v1/models 404) can still be
// asked about one model at a time for free, when they reject an unknown model id
// before anything else. Candidate ids come from the models.dev catalog, synced
// daily: `catalog` is [{ id, name, api, models: [ids] }] (see modelCatalog/sync.js).

// "https://${SNOWFLAKE_ACCOUNT}.snowflakecomputing.com/api/v2/cortex/v1" ->
// host regex (placeholders match one label) + path.
function apiPattern(api) {
  const m = /^https?:\/\/([^/]+)(\/[^?#]*)?/i.exec(String(api || ""));
  if (!m) return null;
  const hostRe = m[1].toLowerCase().split(/\$\{[^}]*\}/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/.]+");
  return { host: new RegExp(`^${hostRe}$`), path: (m[2] || "").replace(/\/+$/, "") };
}

// The catalog provider whose API URL matches this base, best path match first.
export function matchCatalogProvider(base, catalog = []) {
  const u = new URL(base);
  const host = u.hostname.toLowerCase();
  const path = u.pathname.replace(/\/+$/, "");
  let best = null;
  for (const p of catalog) {
    const pat = apiPattern(p.api);
    if (!pat || !pat.host.test(host)) continue;
    const score = path === pat.path ? 3 : path.startsWith(pat.path) || pat.path.startsWith(path) ? 2 : 1;
    if (!best || score > best.score) best = { ...p, score };
  }
  return best;
}

// Generation number from a model id. Families that version in whole steps
// (claude-opus-4-5 / 4-8, gpt-5.x) group by the whole number; families that
// ship "3.5, 3.6, 3.7" as separate generations (qwen, glm) keep the decimal.
// Callers pick which with `decimal`.
export function majorVersion(id, decimal = false) {
  const m = /(\d+)(?:[.-](\d+))?/.exec(String(id).replace(/^[a-z]+-?[a-z]*?(?=\d)/i, "").replace(/^[a-z]+(?=\d)/i, ""));
  if (!m) return 0;
  return decimal && m[2] !== undefined && m[2].length === 1 ? +`${m[1]}.${m[2]}` : +m[1];
}

// Ids dated or tagged as a snapshot ("-20251001", "-latest", "-preview"):
// gateways rename these, so they only add requests.
const SNAPSHOT_RE = /-\d{4}-?\d{2}-?\d{2}$|-\d{4}$|-\d{6}$|-latest$|-preview|-exp\b|-ga-|-character|-vision/i;

// The newest `gens` major versions of every model family the labs ship, and
// only families with a release in the last `maxAgeDays`. Old generations are
// left out on purpose: nobody adds an endpoint for them.
export function recentLabModels(labs = [], gens = 3, maxAgeDays = 365, now = Date.now()) {
  const cutoff = new Date(now - maxAgeDays * 864e5).toISOString().slice(0, 10);
  const byFamily = new Map();
  for (const m of labs) {
    if (SNAPSHOT_RE.test(m.id)) continue;
    const key = `${m.lab}/${m.family}`;
    if (!byFamily.has(key)) byFamily.set(key, []);
    byFamily.get(key).push(m);
  }
  const out = [];
  for (const models of byFamily.values()) {
    if (!models.some((m) => m.date >= cutoff)) continue; // family went quiet
    // Whole-number versions unless the family's whole numbers barely move
    // (all its recent models share one major: qwen3.x, glm-5.x).
    // Versionless ids ("qwen-max", "qwen-plus") are aliases for whatever is
    // current, so they always stay. Everything else must be a recent generation.
    const versioned = models.filter((m) => majorVersion(m.id) > 0);
    const decimal = new Set(versioned.map((m) => majorVersion(m.id))).size < gens;
    const gen = (m) => majorVersion(m.id, decimal);
    // qwen2-5-* is "2.5", not "2-5": a single-digit dash part counts as a decimal.
    const keep = [...new Set(versioned.map(gen))].sort((a, b) => b - a).slice(0, gens);
    models.filter((m) => majorVersion(m.id) === 0 || keep.includes(gen(m)))
      .sort((a, b) => b.date.localeCompare(a.date))
      .forEach((m) => out.push(m));
  }
  return [...new Set(out.sort((a, b) => b.date.localeCompare(a.date)).map((m) => m.id))];
}

// Gateways often prefix a vendor's ids with its name (Snowflake: "openai-gpt-5").
// Learn the prefixes from the matched provider's own list.
function vendorPrefixes(models = []) {
  const seen = new Set();
  for (const id of models) { const m = /^(openai|anthropic|google|meta|mistral|deepseek|xai|qwen|moonshot)-/i.exec(id); if (m) seen.add(m[1].toLowerCase()); }
  return seen;
}
const LAB_PREFIX = { openai: /^(gpt|o\d)/, anthropic: /^claude/, google: /^gem/, meta: /^(llama|muse)/, mistral: /^(mistral|ministral|devstral|codestral|magistral|pixtral)/, deepseek: /^deepseek/, xai: /^grok/, qwen: /^qwen/, moonshot: /^kimi/ };

// What to ask about when there's no /models: the matched provider's list first,
// then the latest generations from every lab (under the gateway's own prefixes).
export function candidateModels(base, catalog = {}) {
  const providers = Array.isArray(catalog) ? catalog : catalog.providers || [];
  const matched = matchCatalogProvider(base, providers);
  const recent = recentLabModels(catalog.labs || []);
  const prefixes = vendorPrefixes(matched?.models);
  const prefixed = recent.flatMap((id) => [...prefixes].filter((p) => LAB_PREFIX[p]?.test(id)).map((p) => `${p}-${id}`));
  const ids = [...new Set([...(matched?.models || []), ...prefixed, ...recent].filter((id) => !SNAPSHOT_RE.test(id)))];
  return { matched, ids };
}

// Error-body fragments that mean "your request reached a real model endpoint".
const UNKNOWN_MODEL_RE = /unknown model|model[^"]{0,40}(not found|does not exist|not supported|invalid)|no such model|invalid model|无可用渠道/i;
// Known to the endpoint but not usable here.
const NOT_SERVABLE_RE = /legacy|does not support this endpoint|deprecated model/i;
const CLIENT_GATE_RE = /unauthorized client|client (is )?not allowed|unsupported client/i;

const redact = (text, key) => (key ? String(text).split(key).join("<key>") : String(text));

const isHtml = (ct, text) => /text\/html/i.test(ct || "") || /^\s*<(!doctype|html)/i.test(text || "");
const htmlTitle = (text) => (/<title[^>]*>([^<]{1,120})/i.exec(text || "")?.[1] || "").trim();

const ANTHROPIC = { "anthropic-version": "2023-06-01" };

function authHeaders(key) {
  return {
    bearer: key ? { authorization: `Bearer ${key}` } : {},
    "x-api-key": key ? { "x-api-key": key } : {},
    both: key ? { authorization: `Bearer ${key}`, "x-api-key": key } : {},
  };
}

// Empty-body requests: a real API rejects them with 400 before running a model.
function probeSpecs(AUTH) {
  return {
    anthropic: { path: "/messages", label: "POST /messages (empty)", headers: { ...AUTH.both, ...ANTHROPIC }, body: { model: "probe", max_tokens: 1, messages: [] } },
    "openai-chat": { path: "/chat/completions", label: "POST /chat/completions (empty)", headers: AUTH.bearer, body: { model: "probe", messages: [], max_tokens: 1, stream: false } },
    "openai-responses": { path: "/responses", label: "POST /responses (empty)", headers: AUTH.bearer, body: { model: "probe", input: [], max_output_tokens: 1, stream: false } },
  };
}

// A 400 or 422 whose body isn't an auth complaint = path exists, key passed.
const accepted = (r) => (r.status === 400 || r.status === 422) && !/unauthori[sz]ed|invalid (api )?key|authentication/i.test(r.text);
const authFail = (r) => r.status === 401 || r.status === 403;

// Records every request as a step (status + body preview, key redacted).
function makeProber({ fetchFn, key, steps, timeoutMs }) {
  return async (label, method, target, { headers = {}, body } = {}) => {
    const step = { label, method, url: target, status: null, preview: "" };
    try {
      const res = await fetchFn(target, {
        method,
        headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text().catch(() => "");
      step.status = res.status;
      step.preview = redact(text, key).replace(/\s+/g, " ").slice(0, BODY_PREVIEW);
      step.html = isHtml(res.headers?.get?.("content-type"), text);
      steps.push(step);
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, text, json, step };
    } catch (e) {
      step.status = 0;
      step.preview = redact(e?.message || String(e), key).slice(0, BODY_PREVIEW);
      steps.push(step);
      return { status: 0, text: "", json: null, step };
    }
  };
}

const PROBE_CONCURRENCY = 6;

// Model probes send only what's required, so the model name is the first thing
// validated. The empty messages/input still means nothing can run. OpenAI-style
// gateways can reject max_tokens first (Snowflake: "deprecated in favor of
// max_completion_tokens"); Anthropic requires max_tokens.
function modelBody(p, model) {
  const { max_tokens, max_output_tokens, stream, ...rest } = p.body;
  return p.path === "/messages" ? { ...p.body, model } : { ...rest, model };
}

// Ask about each id with an empty body. Returns the ids the endpoint knows, or
// null when it doesn't validate model names first (then probing tells us nothing).
async function probeModels({ probe, base, protocol, AUTH, ids }) {
  const p = probeSpecs(AUTH)[protocol];
  if (!p || !ids.length) return null;
  // Canary: a made-up id must be refused as unknown, or "accepted" means nothing.
  const canary = await probe("Check model (made-up id)", "POST", `${base}${p.path}`, { headers: p.headers, body: modelBody(p, "10router-no-such-model") });
  if (!UNKNOWN_MODEL_RE.test(canary.text)) return null;
  const ok = [];
  const queue = [...new Set(ids)];
  await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, async () => {
    for (let id; (id = queue.shift()) !== undefined;) {
      const r = await probe(`Check model ${id}`, "POST", `${base}${p.path}`, { headers: p.headers, body: modelBody(p, id) });
      if (accepted(r) && !UNKNOWN_MODEL_RE.test(r.text) && !NOT_SERVABLE_RE.test(r.text)) ok.push(id);
    }
  }));
  // Keep catalog order, not completion order.
  const order = new Map(ids.map((id, i) => [id, i]));
  return ok.sort((a, b) => order.get(a) - order.get(b));
}

// Models for an already-known endpoint (the "Import models" button): /models
// first, then the catalog probe. Free requests only.
export async function discoverModels({ baseUrl, apiKey, protocol, fetchFn, catalog = {}, timeoutMs = PROBE_TIMEOUT_MS }) {
  const key = cleanKey(apiKey);
  const base = String(baseUrl || "").replace(/\/+$/, "").replace(/\/messages$/, "");
  const steps = [];
  const probe = makeProber({ fetchFn, key, steps, timeoutMs });
  const AUTH = authHeaders(key);
  const styles = protocol === "anthropic" ? [["x-api-key", { ...AUTH.both, ...ANTHROPIC }]] : [["bearer", AUTH.bearer]];
  for (const [style, h] of [["none", {}], ...styles]) {
    const r = await probe(`GET /models (${style === "none" ? "no auth" : style})`, "GET", `${base}/models`, { headers: h });
    if (r.status >= 200 && r.status < 300 && !r.step.html) {
      const ids = parseModelList(r.json);
      if (ids.length) return { models: ids, source: "models", steps };
    }
    if (r.status === 404 || r.status === 0) break;
  }
  const { matched, ids } = candidateModels(base, catalog);
  const found = await probeModels({ probe, base, protocol, AUTH, ids });
  if (found?.length) return { models: found, source: matched ? "catalog" : "guessed", catalogName: matched?.name, steps };
  return { models: [], source: "none", steps };
}

// Probe runner. `fetchFn` is injected so tests (and the SSRF-safe fetch) can supply it.
export async function detectEndpoint({ url, apiKey, fetchFn, catalog = {}, timeoutMs = PROBE_TIMEOUT_MS }) {
  const key = cleanKey(apiKey);
  const base0 = normalizeUrl(url);
  const steps = [];
  if (!base0) return { ok: false, error: "That doesn't look like a URL.", steps };

  const probe = async (label, method, target, { headers = {}, body } = {}) => {
    const step = { label, method, url: target, status: null, preview: "" };
    try {
      const res = await fetchFn(target, {
        method,
        headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text().catch(() => "");
      step.status = res.status;
      step.preview = redact(text, key).replace(/\s+/g, " ").slice(0, BODY_PREVIEW);
      step.html = isHtml(res.headers?.get?.("content-type"), text);
      steps.push(step);
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, text, json, step };
    } catch (e) {
      step.status = 0;
      step.preview = redact(e?.message || String(e), key).slice(0, BODY_PREVIEW);
      steps.push(step);
      return { status: 0, text: "", json: null, step };
    }
  };

  const AUTH = authHeaders(key);
  const PROBES = probeSpecs(AUTH);
  // A 400 or 422 whose body isn't an auth complaint = path exists, key passed.

  let models = [];
  let base = base0;
  let modelsAuth = null;
  let sawAuthFail = false;
  let clientGated = false;

  // 1. Model list: no auth, then each auth style, on each candidate base.
  outer:
  for (const b of candidateBases(base0)) {
    for (const [style, h] of [["none", {}], ["bearer", AUTH.bearer], ["x-api-key", { ...AUTH["x-api-key"], ...ANTHROPIC }]]) {
      if (style !== "none" && !key) continue;
      const r = await probe(`GET /models (${style === "none" ? "no auth" : style})`, "GET", `${b}/models`, { headers: h });
      if (r.status >= 200 && r.status < 300 && !r.step.html) {
        const ids = parseModelList(r.json);
        if (ids.length || Array.isArray(r.json?.data)) { models = ids; base = b; modelsAuth = style; break outer; }
      }
      if (authFail(r)) sawAuthFail = true;
      if (CLIENT_GATE_RE.test(r.text)) clientGated = true;
      if (r.status === 404 || r.status === 0) break; // nothing at this path for any auth
    }
  }

  // 2. Protocol: empty-body probes. Anthropic first when the host/key hints at it.
  const preferAnthropic = /anthropic|claude|cortex|snowflake/i.test(base0) || /^sk-ant-/.test(key);
  const order = preferAnthropic ? ["anthropic", "openai-chat", "openai-responses"] : ["openai-chat", "openai-responses", "anthropic"];
  const found = [];
  for (const b of models.length ? [base] : candidateBases(base0)) {
    for (const proto of order) {
      const p = PROBES[proto];
      const r = await probe(p.label, "POST", `${b}${p.path}`, { headers: p.headers, body: p.body });
      if (authFail(r)) { sawAuthFail = true; if (CLIENT_GATE_RE.test(r.text)) clientGated = true; continue; }
      if (r.step.html || r.status === 404 || r.status === 405 || r.status === 0) continue;
      if (accepted(r) || UNKNOWN_MODEL_RE.test(r.text) || r.status === 503) found.push({ proto, base: b });
    }
    if (found.length) { base = found[0].base; break; }
  }

  if (!found.length) {
    const last = steps[steps.length - 1];
    const html = steps.find((s) => s.html);
    const error = clientGated ? "This endpoint only accepts specific clients."
      : sawAuthFail ? "The key was rejected."
      : html ? `This isn't an API response${htmlTitle(html.preview) ? ` (got "${htmlTitle(html.preview)}")` : ""}.`
      : last?.status === 0 ? `Couldn't reach it: ${last.preview}`
      : "No OpenAI or Anthropic API found at this URL.";
    return { ok: false, error, baseUrl: base0, steps, clientGated, authRejected: sawAuthFail };
  }

  const protocol = found[0].proto;
  // Quirks we can read off the free probes' error bodies.
  const quirks = {};
  if (steps.some((st) => /chat\/completions/.test(st.url) && /max_completion_tokens/.test(st.preview))) quirks.maxCompletionTokens = true;
  const protocols = [...new Set(found.map((f) => f.proto))];

  // 3. Is the key really checked? A bad key must be refused, or "works" means nothing.
  let keyConfirmed = modelsAuth && modelsAuth !== "none" ? "likely" : "unknown";
  if (key) {
    const p = PROBES[protocol];
    const badHeaders = Object.fromEntries(Object.entries(p.headers).map(([k, v]) => [k, k === "authorization" ? "Bearer 10router-bad-key-check" : k === "x-api-key" ? "10router-bad-key-check" : v]));
    const r = await probe("Bad-key check", "POST", `${base}${p.path}`, { headers: badHeaders, body: p.body });
    keyConfirmed = authFail(r) ? "confirmed" : r.status === 400 ? "unknown" : keyConfirmed;
  }

  // 4. No list? Ask about candidate models one at a time, still free.
  let modelsSource = models.length ? "models" : "none";
  const { matched, ids: candidates } = candidateModels(base, catalog);
  if (!models.length) {
    const found = await probeModels({ probe, base, protocol, AUTH, ids: candidates });
    if (found?.length) { models = found; modelsSource = matched ? "catalog" : "guessed"; }
  }

  const name = matched?.name || suggestName(base);
  return {
    ok: true,
    protocol,
    protocols,
    baseUrl: base,
    models,
    modelsSource,
    keyConfirmed,
    quirks,
    suggestedName: name,
    suggestedPrefix: makePrefix(name),
    steps,
  };
}
