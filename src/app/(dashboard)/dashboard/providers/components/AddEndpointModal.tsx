"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, ComponentType, ReactNode } from "react";
import * as Shared from "@/shared/components";
import { makePrefix, suggestName, normalizeUrl, cleanKey } from "@/lib/endpointDetect.js";
import type { Protocol, DetectStep, DetectQuirks, DetectResult } from "@/lib/endpointDetect.js";
import { RESERVED_PREFIXES, PREFIX_MAX_LENGTH, isReservedPrefix, prefixFormatProblem } from "@/shared/utils/reservedPrefixes.js";

// The shared components are untyped JS, so their inferred props mark every
// option as required. Re-type the ones used here with the props we pass.
interface ModalProps {
  isOpen: boolean;
  title: string;
  onClose: () => void;
  children?: ReactNode;
}
interface InputProps {
  label: string;
  value: string;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  icon?: string;
  type?: string;
  placeholder?: string;
  hint?: string;
  error?: string;
  ignorePasswordManagers?: boolean;
}
interface ButtonProps {
  children?: ReactNode;
  variant?: string;
  icon?: string;
  fullWidth?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}
interface BadgeProps {
  children?: ReactNode;
  variant?: string;
  size?: string;
}
interface ToggleProps {
  checked: boolean;
  onChange: (v: boolean) => void;
}
const Modal = Shared.Modal as ComponentType<ModalProps>;
const Input = Shared.Input as ComponentType<InputProps>;
const Button = Shared.Button as ComponentType<ButtonProps>;
const Badge = Shared.Badge as ComponentType<BadgeProps>;
const Toggle = Shared.Toggle as ComponentType<ToggleProps>;

interface ProtocolInfo {
  label: string;
  nodeType: string;
  apiType?: string;
}

const PROTOCOLS: Record<Protocol, ProtocolInfo> = {
  anthropic: { label: "Anthropic · Messages", nodeType: "anthropic-compatible" },
  "openai-chat": { label: "OpenAI · Chat Completions", nodeType: "openai-compatible", apiType: "chat" },
  "openai-responses": { label: "OpenAI · Responses", nodeType: "openai-compatible", apiType: "responses" },
};

type KeyStatus = "confirmed" | "likely" | "unknown";

const KEY_STATUS: Record<KeyStatus, string> = {
  confirmed: "Key checked: a wrong key is refused.",
  likely: "Key accepted.",
  unknown: "Couldn't confirm the key. It will be checked on the first request.",
};

// Optional extras the detector may send on a partial run.
interface PartialInfo {
  reason?: string;
  checked?: number;
  total?: number;
}

// The detect route's JSON: the detector's result, or the local error stand-in
// built on a network failure. Fields beyond DetectResult are read defensively.
type DetectResponse = Omit<Partial<DetectResult>, "partial"> & {
  ok: boolean;
  error?: string;
  steps?: DetectStep[];
  partial?: boolean | PartialInfo;
  checked?: number;
  total?: number;
  keyRejected?: boolean;
};

// The node the server returns from POST /api/provider-nodes.
interface CreatedNode {
  id: string;
  [key: string]: unknown;
}

interface CreatedInfo {
  keyError: string | null;
  modelsFailed: number;
  modelsTotal: number;
}

interface SaveNodeResponse {
  node?: CreatedNode;
  error?: string;
  field?: string;
}

// "Both APIs work: 13 models on Anthropic Messages, 35 on OpenAI Chat. Claude
// goes to Messages, the rest to Chat." Null unless models really split.
const SHORT: Record<Protocol, string> = { anthropic: "Messages", "openai-chat": "Chat", "openai-responses": "Responses" };
function describeTwoPath(detected: DetectResponse | null): string | null {
  const by = detected?.byProtocol;
  const used = by ? (Object.entries(by) as [Protocol, string[] | undefined][]).filter(([, ids]) => ids?.length) : [];
  if (used.length < 2) return null;
  const counts = used.map(([p, ids]) => `${ids!.length} on ${PROTOCOLS[p].label.replace(" · ", " ")}`).join(", ");
  const others = used.map(([p]) => p).filter((p) => p !== "anthropic");
  const rule = used.some(([p]) => p === "anthropic") && others.length
    ? ` Claude goes to ${SHORT.anthropic}, the rest to ${SHORT[others.includes("openai-responses") ? "openai-responses" : others[0]]}.`
    : "";
  return `Both APIs work: ${counts}.${rule}`;
}


interface ProbeListProps {
  steps?: DetectStep[];
}

function ProbeList({ steps }: ProbeListProps) {
  if (!steps?.length) return null;
  return (
    <details className="group rounded-[10px] bg-surface-2">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-[10px] px-3 py-2 text-xs text-text-muted hover:text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60">
        <span className="material-symbols-outlined text-[16px] transition-transform group-open:rotate-90" aria-hidden="true">chevron_right</span>
        How we tested it <span className="text-text-subtle">· {steps.length} free requests</span>
      </summary>
      <ul className="flex flex-col gap-1.5 px-3 pb-3">
        {steps.map((s, i) => (
          <li key={i} className="flex min-w-0 flex-col gap-0.5 text-xs">
            <div className="flex items-center gap-2">
              <span className={`w-8 shrink-0 font-mono ${s.status >= 200 && s.status < 300 ? "text-green-600 dark:text-green-400" : "text-text-subtle"}`}>{s.status || "ERR"}</span>
              <span className="text-text-main">{s.label}</span>
            </div>
            {s.preview && <span className="ml-10 truncate font-mono text-[11px] text-text-subtle" title={s.preview}>{s.preview}</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}

const DETECT_TIMEOUT_MS = 60_000;
// Matches MAX_BULK in src/app/api/models/custom/route.js.
const MODELS_PER_REQUEST = 1000;
interface ModalQuirks extends DetectQuirks {
  stripBeta: boolean;
  maxCompletionTokens: boolean;
}

const DEFAULT_QUIRKS: ModalQuirks = { stripBeta: false, maxCompletionTokens: false };

// "rate_limited" -> "rate limited"
const humanize = (v: unknown): string => String(v).replace(/[_-]+/g, " ").trim();

// Detection that ran out of time or budget. The detector may or may not send
// these fields; read them defensively and say nothing when they're absent.
function partialNote(r: DetectResponse | null): string | null {
  if (!r?.partial) return null;
  const p: PartialInfo = typeof r.partial === "object" ? r.partial : {};
  const reason = r.partialReason || p.reason;
  const checked = r.checked ?? p.checked;
  const total = r.total ?? p.total;
  const counts = Number.isFinite(checked) && Number.isFinite(total) && total! > 0 ? ` (${checked} of ${total} checked)` : "";
  return `Stopped early${reason ? `: ${humanize(reason)}` : ""}${counts}. Add any missing models on the endpoint page.`;
}

// True when the endpoint refused the key, as opposed to having no model list.
function keyRefused(r: DetectResponse | null): boolean {
  if (!r) return false;
  if (r.keyRejected === true || r.authRejected === true) return true;
  if (r.ok && r.models?.length) return false;
  return (r.steps || []).some((s) => /\/models$/.test(s.url || "") && (s.status === 401 || s.status === 403));
}

interface AddEndpointModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (node: CreatedNode, info: CreatedInfo) => void;
  takenPrefixes?: string[];
}

type Phase = "idle" | "detecting" | "found" | "failed";

interface DetectInFlight {
  id: number;
  controller: AbortController | null;
  timer: ReturnType<typeof setTimeout> | null;
}

function AddEndpointModal({ isOpen, onClose, onCreated, takenPrefixes = [] }: AddEndpointModalProps) {
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [phase, setPhase] = useState<Phase>("idle"); // idle | detecting | found | failed
  const [result, setResult] = useState<DetectResponse | null>(null);
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [prefix, setPrefix] = useState("");
  const [prefixEdited, setPrefixEdited] = useState(false);
  const [protocol, setProtocol] = useState<Protocol | null>(null);
  const [quirks, setQuirks] = useState<ModalQuirks>(DEFAULT_QUIRKS);
  const [manualModels, setManualModels] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [prefixError, setPrefixError] = useState("");
  const [elapsed, setElapsed] = useState(0);
  // The detection in flight: a newer one (or a close/edit) aborts it, and a stale
  // response is dropped by id even if it already arrived.
  const detectRef = useRef<DetectInFlight>({ id: 0, controller: null, timer: null });

  // Built-in provider names are taken too: routing sends `kimi/…` to Kimi.
  const taken = useMemo<string[]>(() => [...takenPrefixes, ...RESERVED_PREFIXES], [takenPrefixes]);
  const suggestPrefix = (n: string): string => makePrefix(n, taken);
  const prefixIssue = (p: string): string => {
    const v = String(p || "").trim().toLowerCase();
    if (!v) return "";
    const format = prefixFormatProblem(v);
    if (format) return format;
    if (isReservedPrefix(v)) return `"${v}" is a built-in provider's name, so ${v}/… would go there. Pick another prefix.`;
    if (takenPrefixes.some((t) => String(t).toLowerCase() === v)) return `"${v}" is already used by another endpoint.`;
    return "";
  };

  const stopDetect = () => {
    const cur = detectRef.current;
    cur.id += 1;
    cur.controller?.abort();
    clearTimeout(cur.timer ?? undefined);
    cur.controller = null;
    cur.timer = null;
  };

  // Drop everything learned from a detection, keeping what the user typed.
  const clearResults = () => {
    stopDetect();
    setPhase("idle"); setResult(null); setProtocol(null); setQuirks(DEFAULT_QUIRKS);
    if (!nameEdited) setName("");
    if (!prefixEdited) setPrefix("");
    setError(""); setPrefixError("");
  };

  const reset = () => {
    stopDetect();
    setUrl(""); setApiKey(""); setPhase("idle"); setResult(null); setName(""); setNameEdited(false); setPrefix("");
    setPrefixEdited(false); setProtocol(null); setQuirks(DEFAULT_QUIRKS);
    setManualModels(""); setError(""); setPrefixError(""); setElapsed(0);
  };
  const close = () => { reset(); onClose(); };

  // Closed from outside, or unmounted: nothing may land in the next session.
  useEffect(() => { if (!isOpen) stopDetect(); }, [isOpen]);
  useEffect(() => () => stopDetect(), []);

  // Elapsed seconds while testing.
  useEffect(() => {
    if (phase !== "detecting") return undefined;
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, [phase]);

  const detect = async () => {
    stopDetect();
    const cur = detectRef.current;
    const id = cur.id;
    const controller = new AbortController();
    let timedOut = false;
    cur.controller = controller;
    cur.timer = setTimeout(() => { timedOut = true; controller.abort(); }, DETECT_TIMEOUT_MS);
    const live = () => detectRef.current.id === id;

    setPhase("detecting"); setElapsed(0); setError(""); setPrefixError(""); setResult(null);
    try {
      const res = await fetch("/api/provider-nodes/detect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, apiKey }),
        signal: controller.signal,
      });
      const data: DetectResponse = await res.json();
      if (!live()) return;
      setResult(data);
      if (data.ok) {
        setProtocol(data.protocol!);
        if (!nameEdited) setName(data.suggestedName || "");
        if (!prefixEdited) setPrefix(suggestPrefix(nameEdited ? name : data.suggestedName!));
        setQuirks({ ...DEFAULT_QUIRKS, ...(data.quirks || {}) });
        setPhase("found");
      } else {
        // Still offer a name from the host, so "Save anyway" is one click.
        const base = data.baseUrl || normalizeUrl(url);
        const guess = base ? suggestName(base) : "";
        if (!nameEdited && guess) { setName(guess); if (!prefixEdited) setPrefix(suggestPrefix(guess)); }
        setProtocol(null);
        setPhase("failed");
      }
    } catch {
      if (!live()) return; // cancelled, closed or superseded
      const base = normalizeUrl(url);
      const guess = base ? suggestName(base) : "";
      if (!nameEdited && guess) { setName(guess); if (!prefixEdited) setPrefix(suggestPrefix(guess)); }
      setResult({
        ok: false,
        error: timedOut ? "Testing took over a minute, so we stopped. The endpoint may be slow or rate limiting; try again, or save it and add models by hand." : "Network error",
        steps: [],
      });
      setPhase("failed");
    } finally {
      if (live()) { clearTimeout(cur.timer ?? undefined); cur.controller = null; cur.timer = null; }
    }
  };

  const cancelDetect = () => {
    stopDetect();
    setPhase(result ? (result.ok ? "found" : "failed") : "idle");
  };

  const onUrlOrKeyEdit = () => { if (phase !== "idle" || result) clearResults(); };

  const onNameChange = (v: string) => {
    setName(v); setNameEdited(true);
    if (!prefixEdited) { setPrefix(suggestPrefix(v)); setPrefixError(""); }
  };

  const save = async () => {
    const chosen = protocol || result?.protocol || "openai-chat";
    const proto = PROTOCOLS[chosen];
    const found = phase === "found" && !!result?.ok;
    // A refused key means detection didn't really check this endpoint: save it
    // unverified, like any other unconfirmed endpoint.
    const refused = !!result?.authRejected || keyRefused(result);
    // Verified only when the API type we save is one detection actually saw work.
    const verified = found && !refused && (result!.protocols?.length ? result!.protocols : [result!.protocol]).includes(chosen);
    // Overriding the API type away from the detected primary drops the routes,
    // so only the models seen on the chosen API can be served.
    const detectedModels: string[] = !found
      ? []
      : chosen !== result!.protocol && result!.byProtocol
        ? result!.byProtocol[chosen] || []
        : result!.models || [];
    const models: string[] = found && result!.models?.length
      ? detectedModels
      : manualModels.split(/[\s,]+/).map((m) => m.trim()).filter(Boolean);
    if (!name.trim() || !prefix.trim()) { setError("Name and prefix are required."); return; }
    const issue = prefixIssue(prefix);
    if (issue) { setPrefixError(issue); return; }
    setSaving(true); setError(""); setPrefixError("");
    try {
      let node: CreatedNode;
      try {
        // The server returns the existing node when the same endpoint was already
        // saved, so a retry after a lost response doesn't add a duplicate.
        const nodeRes = await fetch("/api/provider-nodes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            prefix: prefix.trim(),
            type: proto.nodeType,
            ...(proto.apiType ? { apiType: proto.apiType } : {}),
            baseUrl: result?.baseUrl || normalizeUrl(url) || url,
            // Routes are relative to the node's own path; only save them when the
            // user kept the detected primary (a manual API-type override wins).
            quirks: { ...quirks, ...(found && result?.routes && chosen === result.protocol ? { modelRoutes: result.routes } : {}) },
            verified,
          }),
        });
        const nodeData: SaveNodeResponse = await nodeRes.json().catch(() => ({}));
        if (!nodeRes.ok || !nodeData.node) {
          // e.g. a prefix taken since the list was loaded: the user can fix it and retry.
          if (nodeData.field === "prefix") setPrefixError(nodeData.error ?? "");
          else setError(nodeData.error || "Couldn't save the endpoint.");
          return;
        }
        node = nodeData.node;
      } catch {
        setError("Network error. Nothing was saved; try again.");
        return;
      }

      // The node exists from here on, so always finish and close; the page reports
      // what didn't save.
      let keyError: string | null = null;
      if (apiKey.trim()) {
        try {
          const connRes = await fetch("/api/providers", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              provider: node.id,
              apiKey: cleanKey(apiKey),
              defaultModel: models[0] || null,
              testStatus: verified ? "active" : "unknown",
            }),
          });
          if (!connRes.ok) {
            const d: { error?: string } = await connRes.json().catch(() => ({}));
            keyError = d.error || `HTTP ${connRes.status}`;
          }
        } catch {
          keyError = "network error";
        }
      }

      // The bulk route takes at most MODELS_PER_REQUEST at a time.
      let modelsFailed = 0;
      for (let i = 0; i < models.length; i += MODELS_PER_REQUEST) {
        const chunk = models.slice(i, i + MODELS_PER_REQUEST);
        try {
          const res = await fetch("/api/models/custom", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ providerAlias: node.id, type: "llm", models: chunk }),
          });
          const d: { failed?: unknown } = await res.json().catch(() => ({}));
          modelsFailed += Array.isArray(d.failed) ? d.failed.length : res.ok ? 0 : chunk.length;
        } catch {
          modelsFailed += chunk.length;
        }
      }
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("customModelChanged"));
      onCreated(node, { keyError, modelsFailed, modelsTotal: models.length });
      reset();
    } finally {
      setSaving(false);
    }
  };

  const detected = result?.ok ? result : null;
  const available: Protocol[] = detected?.protocols?.length ? detected.protocols : (Object.keys(PROTOCOLS) as Protocol[]);
  const isAnthropic = (protocol || detected?.protocol) === "anthropic";
  const twoPath = describeTwoPath(detected);
  const partial = partialNote(result);
  const keyProblem = keyRefused(result);
  const overrideUnverified = detected && protocol && !available.includes(protocol);
  const testing = phase === "detecting";

  return (
    <Modal isOpen={isOpen} title="Add endpoint" onClose={close}>
      <div className="flex flex-col gap-4">
        <Input
          label="Endpoint URL"
          icon="link"
          value={url}
          onChange={(e: ChangeEvent<HTMLInputElement>) => { setUrl(e.target.value); onUrlOrKeyEdit(); }}
          placeholder="https://api.example.com/v1"
          hint="Any form works: base URL, /v1, /messages, /chat/completions."
          ignorePasswordManagers
        />
        <Input
          label="API key"
          icon="key"
          type="password"
          value={apiKey}
          onChange={(e: ChangeEvent<HTMLInputElement>) => { setApiKey(e.target.value); onUrlOrKeyEdit(); }}
          hint="Optional for local servers that don't need one."
          ignorePasswordManagers
        />

        {(phase === "idle" || testing) && (
          <>
            {testing ? (
              <div className="flex gap-2">
                <Button icon="bolt" fullWidth disabled>Testing… {elapsed}s</Button>
                <Button variant="secondary" onClick={cancelDetect}>Cancel</Button>
              </div>
            ) : (
              <Button icon="bolt" fullWidth onClick={detect} disabled={!url.trim()}>Connect</Button>
            )}
            <p className="text-center text-xs text-text-muted">
              {testing
                ? elapsed < 8 ? "Finding the API type…" : "Checking models… endpoints with no model list take longer (up to a minute)."
                : "We work out the API type, models and quirks with free requests only. Nothing gets generated."}
            </p>
          </>
        )}

        <div aria-live="polite" className="flex flex-col gap-4 empty:hidden">
          {phase === "failed" && (
            <div role="alert" className="flex items-start gap-2 rounded-[10px] border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-600 dark:text-red-400">
              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">{keyProblem ? "key_off" : "error"}</span>
              <span>
                {keyProblem
                  ? "The endpoint rejected this API key. Check that it's correct, active and not revoked, then try again."
                  : result?.error || "Couldn't detect this endpoint."}
              </span>
            </div>
          )}

          {phase === "found" && detected && (
            <div className="flex flex-col gap-3 rounded-[10px] border border-green-500/20 bg-green-500/5 p-4">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-[20px] text-green-500" aria-hidden="true">check_circle</span>
                <span className="text-sm font-semibold text-text-main">It works</span>
                <span className="ml-auto"><Badge variant="success" size="sm">{protocol ? PROTOCOLS[protocol]?.label : undefined}</Badge></span>
              </div>
              <p className="text-xs text-text-muted">{KEY_STATUS[detected.keyConfirmed as KeyStatus] || KEY_STATUS.unknown}</p>
              {(detected.models?.length ?? 0) > 0 ? (
                <div className="flex flex-col gap-1.5">
                  <div className="flex flex-wrap gap-1.5">
                    {detected.models!.slice(0, 8).map((m) => (
                      <span key={m} className="rounded-full border border-border-subtle bg-surface px-2 py-0.5 font-mono text-[11px] text-text-muted">{m}</span>
                    ))}
                    {detected.models!.length > 8 && <span className="px-1 text-[11px] text-text-subtle">+{detected.models!.length - 8} more</span>}
                  </div>
                  {(detected.modelsSource === "catalog" || detected.modelsSource === "guessed") && (
                    <p className="text-[11px] text-text-subtle">No model list here, so we checked known models one by one. Add any we missed on the endpoint page.</p>
                  )}
                </div>
              ) : keyProblem ? (
                <p className="text-xs text-red-600 dark:text-red-400">The endpoint answered, but refused this key when listing models. Check the key; it may be revoked.</p>
              ) : (
                <p className="text-xs text-text-muted">No model list found. Add model IDs below.</p>
              )}
              {partial && (
                <p className="flex items-start gap-1 text-xs text-amber-700 dark:text-amber-400">
                  <span className="material-symbols-outlined text-[14px]" aria-hidden="true">hourglass_disabled</span>
                  <span>{partial}</span>
                </p>
              )}
              {twoPath && (
                <p className="flex items-start gap-1 text-xs text-text-muted">
                  <span className="material-symbols-outlined text-[14px] text-primary" aria-hidden="true">alt_route</span>
                  <span>{twoPath}</span>
                </p>
              )}
              {isAnthropic && (
                <p className="flex items-start gap-1 text-xs text-text-muted">
                  <span className="material-symbols-outlined text-[14px] text-primary" aria-hidden="true">auto_fix_high</span>
                  <span>Beta flags can&apos;t be checked for free. If a request is rejected for one, we drop that flag, retry, and remember it.</span>
                </p>
              )}
            </div>
          )}
        </div>

        {(phase === "found" || phase === "failed") && (
          <>
            <ProbeList steps={result?.steps} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_8rem]">
              <Input label="Name" value={name} onChange={(e: ChangeEvent<HTMLInputElement>) => onNameChange(e.target.value)} placeholder="My endpoint" />
              <Input
                label="Prefix"
                value={prefix}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  const v = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, PREFIX_MAX_LENGTH);
                  setPrefix(v); setPrefixEdited(true); setPrefixError(prefixIssue(v));
                }}
                placeholder="ep"
                error={prefixError || undefined}
                hint={!prefixError && prefix ? `${prefix}/model-id` : ""}
              />
            </div>
            {(!detected || !detected.models?.length) && (
              <Input
                label="Model IDs"
                value={manualModels}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setManualModels(e.target.value)}
                placeholder="model-a, model-b"
                hint="Comma or space separated."
              />
            )}

            <details className="group rounded-[10px] border border-border-subtle" open={phase === "failed"}>
              <summary className="flex cursor-pointer list-none items-center gap-2 rounded-[10px] px-3 py-2 text-xs text-text-muted hover:text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60">
                <span className="material-symbols-outlined text-[16px] transition-transform group-open:rotate-90" aria-hidden="true">chevron_right</span>
                Advanced <span className="text-text-subtle">· if something&apos;s off</span>
              </summary>
              <div className="flex flex-col divide-y divide-border-subtle px-3 pb-2">
                <div className="flex flex-col gap-1 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p id="add-endpoint-api-type" className="text-sm font-medium text-text-main">API type</p>
                    <div role="group" aria-labelledby="add-endpoint-api-type" className="inline-flex flex-wrap items-center gap-1 rounded-[10px] bg-surface-2 p-1">
                      {(Object.entries(PROTOCOLS) as [Protocol, ProtocolInfo][]).map(([v, p]) => (
                        <button
                          key={v}
                          type="button"
                          aria-pressed={protocol === v}
                          title={detected && !available.includes(v) ? "Not detected on this endpoint" : p.label}
                          onClick={() => setProtocol(v)}
                          className={`h-6 rounded-[8px] px-2.5 text-[11px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${protocol === v ? "bg-surface text-text-main shadow-sm" : "text-text-muted hover:text-text-main"} ${available.includes(v) ? "" : "opacity-60"}`}
                        >
                          {p.label.split(" · ")[1]}
                        </button>
                      ))}
                    </div>
                  </div>
                  {overrideUnverified && (
                    <p className="text-xs text-amber-700 dark:text-amber-400">This API wasn&apos;t detected here, so the endpoint will be saved unverified.</p>
                  )}
                </div>
                {isAnthropic && (
                  <div className="flex items-center justify-between gap-4 py-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text-main">Strip all beta flags</p>
                      <p className="text-xs text-text-muted">Off: drop only the flags it rejects. On: send no <code className="font-mono">anthropic-beta</code> at all.</p>
                    </div>
                    <Toggle checked={quirks.stripBeta} onChange={(v: boolean) => setQuirks((q) => ({ ...q, stripBeta: v }))} />
                  </div>
                )}
                {!isAnthropic && (
                  <div className="flex items-center justify-between gap-4 py-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text-main">Send <code className="font-mono">max_completion_tokens</code></p>
                      <p className="text-xs text-text-muted">Rename <code className="font-mono">max_tokens</code> for endpoints that reject it.</p>
                    </div>
                    <Toggle checked={quirks.maxCompletionTokens} onChange={(v: boolean) => setQuirks((q) => ({ ...q, maxCompletionTokens: v }))} />
                  </div>
                )}
              </div>
            </details>

            {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
            <div className="flex flex-col gap-2 sm:flex-row">
              {phase === "failed" && (
                <Button variant="secondary" icon="refresh" fullWidth onClick={detect} disabled={saving}>Try again</Button>
              )}
              <Button fullWidth onClick={save} disabled={saving || !name.trim() || !prefix.trim() || !!prefixError || (phase === "failed" && !protocol)}>
                {saving ? "Saving…" : phase === "failed" ? "Save anyway" : "Add endpoint"}
              </Button>
            </div>
            {phase === "failed" && !protocol && (
              <p className="text-xs text-text-muted">Pick an API type under Advanced to save it unverified.</p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

export default AddEndpointModal;
