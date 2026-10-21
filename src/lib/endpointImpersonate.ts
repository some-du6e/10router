// Client-gated endpoints (agentrouter and other new-api forks) refuse every
// request without a known client's headers, before they even look at the key:
//   401 {"error":{"type":"unauthorized_client_error","message":"unauthorized client detected"}}
// When detection ends with clientGated, ask again as Claude Code, Codex and
// Gemini CLI (free requests only: GET /models and the empty-body probes). If one
// gets in, re-run detection with its headers and report it. Nothing is turned
// on here: the dialog shows "Only works if we pretend to be X" and the user
// picks "Connect as X", which saves mimic = X.
//
// Imported by the detect route (server only), but no node:* imports.
import { classify, cleanKey, joinUrl, makeRedactor, normalizeUrl } from "./endpointDetect.js";
import type { DetectFetch, DetectResult, DetectStep, ProbeResponse } from "./endpointDetect.js";
import { MIMIC_HEADERS, MIMIC_LABELS } from "@/shared/utils/nodeQuirks.js";
import type { Mimic } from "@/shared/utils/nodeQuirks.js";
import { parseHeaderLines } from "@/shared/utils/endpointOverrides.js";

export type ClientPreset = Exclude<Mimic, "none" | "custom">;
// Codex first: the gate we've seen (agentrouter) lets codex_cli_rs and claude-cli in.
export const CLIENT_PRESETS: readonly ClientPreset[] = ["codex", "claude-code", "gemini-cli"];
const PROBE_TIMEOUT_MS = 8000;
const PREVIEW = 300;

export interface ClientGate {
  client: ClientPreset;
  label: string;          // "Codex CLI"
  alsoWorks: string | null; // "Claude Code" (labels, comma separated)
}
export type GatedDetectResult = DetectResult & { gate?: ClientGate };

// A preset's headers as a map (the anthropic-beta line only matters on /messages; harmless elsewhere).
export function presetHeaders(client: ClientPreset): Record<string, string> {
  const out: Record<string, string> = {};
  for (const o of parseHeaderLines(MIMIC_HEADERS[client])) if (o.op === "set") out[o.name] = o.value;
  return out;
}

// fetch that sends a client's identity headers on every request.
export function withClientHeaders(fetchFn: DetectFetch, client: ClientPreset): DetectFetch {
  const extra = presetHeaders(client);
  return (url, init) => {
    const headers = { ...init.headers };
    for (const k of Object.keys(headers)) if (k.toLowerCase() in lower(extra)) delete headers[k];
    return fetchFn(url, { ...init, headers: { ...headers, ...extra } });
  };
}
const lower = (h: Record<string, string>) => Object.fromEntries(Object.keys(h).map((k) => [k.toLowerCase(), true]));

interface ProbeArgs { base: string; key: string; client: ClientPreset; fetchFn: DetectFetch; signal?: AbortSignal | null; steps: DetectStep[]; redact: (t: unknown) => string; timeoutMs: number }

// One free request as `client`. True when the gate let it through: any answer
// that isn't the client-gate refusal, a network error or a 5xx.
async function probeAs({ base, key, client, fetchFn, signal, steps, redact, timeoutMs }: ProbeArgs, method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<boolean> {
  const url = joinUrl(base, path);
  const auth: Record<string, string> = key ? { authorization: `Bearer ${key}`, "x-api-key": key } : {};
  const headers: Record<string, string> = { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...auth, ...(path === "/messages" ? { "anthropic-version": "2023-06-01" } : {}) };
  const timeout = AbortSignal.timeout(timeoutMs);
  const step: DetectStep = { label: `${method} ${path} (as ${MIMIC_LABELS[client]})`, method, url: redact(url), status: 0, preview: "" };
  let res: ProbeResponse;
  try {
    res = await withClientHeaders(fetchFn, client)(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
  } catch (e) {
    step.preview = redact((e as Error)?.message || String(e)).slice(0, PREVIEW);
    steps.push(step);
    return false;
  }
  const text = await res.text().catch(() => "");
  step.status = res.status;
  step.preview = redact(text).replace(/\s+/g, " ").slice(0, PREVIEW);
  steps.push(step);
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  const k = classify({ status: res.status, text, json, step });
  return k !== "gated" && k !== "network" && k !== "server" && k !== "html";
}

export interface FindClientOptions {
  url: unknown;
  apiKey?: unknown;
  fetchFn: DetectFetch;
  signal?: AbortSignal | null;
  timeoutMs?: number;
  presets?: readonly ClientPreset[];
}

// Which client identities get past the gate. Free requests only: GET /models,
// then the empty-body chat and messages probes (rejected before any model runs).
export async function findClientIdentity({ url, apiKey, fetchFn, signal = null, timeoutMs = PROBE_TIMEOUT_MS, presets = CLIENT_PRESETS }: FindClientOptions): Promise<{ works: ClientPreset[]; steps: DetectStep[] }> {
  const base = normalizeUrl(url);
  const steps: DetectStep[] = [];
  if (!base) return { works: [], steps };
  const key = cleanKey(apiKey);
  const redact = makeRedactor(key);
  const works: ClientPreset[] = [];
  for (const client of presets) {
    if (signal?.aborted) break;
    const a: ProbeArgs = { base, key, client, fetchFn, signal, steps, redact, timeoutMs };
    const ok = await probeAs(a, "GET", "/models")
      || await probeAs(a, "POST", "/chat/completions", { model: "probe", messages: [], max_tokens: 1, stream: false })
      || await probeAs(a, "POST", "/messages", { model: "probe", max_tokens: 1, messages: [] });
    if (ok) works.push(client);
  }
  return { works, steps };
}

export interface ImpersonateOptions extends FindClientOptions {
  // Re-runs detection with a wrapped fetch (normally detectEndpoint with the
  // same catalog, deadline and progress callback as the first run).
  detect: (fetchFn: DetectFetch) => Promise<DetectResult>;
}

// After a clientGated detection: try each client, and when one gets in, detect
// again as that client. Returns the original result when nothing gets in.
// The new result keeps clientGated: true and carries `gate`; the extra probes
// are prepended to its steps so "How we tested it" shows them.
export async function retryAsClient(result: DetectResult, opts: ImpersonateOptions): Promise<GatedDetectResult> {
  if (result.ok || !result.clientGated) return result;
  const { works, steps } = await findClientIdentity(opts);
  if (!works.length) return { ...result, steps: [...result.steps, ...steps] };
  const client = works[0];
  const again = await opts.detect(withClientHeaders(opts.fetchFn, client));
  if (!again.ok) return { ...result, steps: [...result.steps, ...steps, ...again.steps] };
  const alsoWorks = works.slice(1).map((c) => MIMIC_LABELS[c]).join(", ") || null;
  return { ...again, clientGated: true, steps: [...result.steps, ...steps, ...again.steps], gate: { client, label: MIMIC_LABELS[client], alsoWorks } };
}
