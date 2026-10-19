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

// Snowflake Cortex has no model list (checked 2026-10-19: /v1/models 404). It does
// validate the model name for free, so these are confirmed one by one by probing.
const KNOWN_CATALOGS = [
  {
    match: (host) => host.endsWith(".snowflakecomputing.com"),
    name: "Snowflake",
    anthropic: ["claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5", "claude-opus-5", "claude-sonnet-5", "claude-sonnet-4-6", "claude-sonnet-4-5", "claude-haiku-4-5"],
    openai: ["openai-gpt-5", "openai-gpt-5-mini", "openai-gpt-5-nano", "claude-haiku-4-5", "claude-sonnet-4-5", "llama4-maverick", "llama3.1-70b", "mistral-large2"],
  },
];
export const catalogFor = (base) => KNOWN_CATALOGS.find((c) => c.match(new URL(base).hostname));

// Error-body fragments that mean "your request reached a real model endpoint".
const UNKNOWN_MODEL_RE = /unknown model|model[^"]{0,40}(not found|does not exist|not supported|invalid)|no such model|invalid model|无可用渠道/i;
const CLIENT_GATE_RE = /unauthorized client|client (is )?not allowed|unsupported client/i;

const redact = (text, key) => (key ? String(text).split(key).join("<key>") : String(text));

const isHtml = (ct, text) => /text\/html/i.test(ct || "") || /^\s*<(!doctype|html)/i.test(text || "");
const htmlTitle = (text) => (/<title[^>]*>([^<]{1,120})/i.exec(text || "")?.[1] || "").trim();

// Probe runner. `fetchFn` is injected so tests (and the SSRF-safe fetch) can supply it.
export async function detectEndpoint({ url, apiKey, fetchFn, timeoutMs = PROBE_TIMEOUT_MS }) {
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

  const AUTH = {
    bearer: key ? { authorization: `Bearer ${key}` } : {},
    "x-api-key": key ? { "x-api-key": key } : {},
    both: key ? { authorization: `Bearer ${key}`, "x-api-key": key } : {},
  };
  const ANTHROPIC = { "anthropic-version": "2023-06-01" };
  // A 400 or 422 whose body isn't an auth complaint = path exists, key passed.
  const accepted = (r) => (r.status === 400 || r.status === 422) && !/unauthori[sz]ed|invalid (api )?key|authentication/i.test(r.text);
  const authFail = (r) => r.status === 401 || r.status === 403;

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
  const PROBES = {
    anthropic: { path: "/messages", label: "POST /messages (empty)", headers: { ...AUTH.both, ...ANTHROPIC }, body: { model: "probe", max_tokens: 1, messages: [] } },
    "openai-chat": { path: "/chat/completions", label: "POST /chat/completions (empty)", headers: AUTH.bearer, body: { model: "probe", messages: [], max_tokens: 1, stream: false } },
    "openai-responses": { path: "/responses", label: "POST /responses (empty)", headers: AUTH.bearer, body: { model: "probe", input: [], max_output_tokens: 1, stream: false } },
  };
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

  // 4. No list? Confirm a known catalog model by model, still free.
  let modelsSource = models.length ? "models" : "none";
  const catalog = catalogFor(base);
  if (!models.length && catalog) {
    const list = protocol === "anthropic" ? catalog.anthropic : catalog.openai;
    const p = PROBES[protocol];
    const ok = [];
    for (const m of list) {
      const r = await probe(`Check model ${m}`, "POST", `${base}${p.path}`, { headers: p.headers, body: { ...p.body, model: m } });
      if (accepted(r) && !UNKNOWN_MODEL_RE.test(r.text) && !/legacy|does not support this endpoint/i.test(r.text)) ok.push(m);
    }
    models = ok;
    modelsSource = "catalog";
  }

  const name = catalog?.name || suggestName(base);
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
