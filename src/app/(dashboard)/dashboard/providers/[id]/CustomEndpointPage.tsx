"use client";

// The page for a user-added OpenAI/Anthropic-compatible endpoint. Layout,
// wording and class strings follow renderDetail() in the approved mockup
// (mockups/provider-setup/src/app.js): header with the endpoint's own icon,
// Endpoint, Recent requests, Keys, Models (by maker) and Advanced last.
// Everything the mockup simulates is real here: the test message goes through
// the router (POST /api/providers/[id]/requests), Re-detect and the Models
// card's refresh run the same free probes as "Add endpoint"
// (POST /api/providers/[id]/redetect?part=endpoint|models).

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, ComponentType, ReactNode } from "react";
import Link from "next/link";
import * as Shared from "@/shared/components";
import { MIMIC_LABELS } from "@/shared/utils/nodeQuirks.js";
import type { Mimic, NodeQuirks, RouteProtocol } from "@/shared/utils/nodeQuirks.js";
import type { EndpointRequestEntry } from "@/lib/endpointRequestLog.js";
import type { RedetectDiff, RedetectPart } from "@/app/api/providers/[id]/redetect/diff.js";
import { PROTOCOL_NAME, prettyModel, readNdjson } from "../components/AddEndpointParts";
import type { DetectProgress } from "@/lib/endpointDetect.js";
import { shrinkIcon } from "../components/shrinkIcon.js";
import { connectionsToTest } from "../utils.js";
import EndpointAdvancedStudio from "../components/EndpointAdvancedStudio";
import EndpointIcon, { TILE_BG } from "@/shared/components/EndpointIcon";
import type { StudioExtra } from "../components/EndpointAdvancedStudio";

interface ModalProps { isOpen: boolean; title: string; onClose: () => void; size?: string; children?: ReactNode }
interface InputProps {
  label?: ReactNode; value: string; onChange: (e: ChangeEvent<HTMLInputElement>) => void; onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  icon?: string; type?: string; placeholder?: string; hint?: ReactNode; ignorePasswordManagers?: boolean; autoFocus?: boolean; id?: string; error?: string;
}
const Modal = Shared.Modal as unknown as ComponentType<ModalProps>;
const Input = Shared.Input as unknown as ComponentType<InputProps>;

// ---- Mockup building blocks (btn / badge / toggle / card) ------------------------

const BTN = "inline-flex items-center justify-center gap-2 font-semibold transition-all duration-150 ease-out cursor-pointer active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100";
const BTN_V: Record<string, string> = {
  primary: "bg-brand-500 hover:bg-brand-600 text-white shadow-sm disabled:bg-surface-3 disabled:text-text-muted",
  secondary: "bg-surface-2 hover:bg-surface-3 text-text-main border border-border disabled:opacity-50",
  ghost: "text-text-muted hover:bg-surface-2 hover:text-text-main",
};
const BTN_S: Record<string, string> = { sm: "h-7 px-3 text-xs rounded-[8px]", md: "h-9 px-4 text-sm rounded-[10px]" };
function Btn({ children, icon, variant = "primary", size = "sm", full, disabled, busy, onClick, title }: { children: ReactNode; icon?: string; variant?: string; size?: string; full?: boolean; disabled?: boolean; busy?: boolean; onClick?: () => void; title?: string }) {
  return (
    <button type="button" title={title} onClick={onClick} disabled={disabled} className={`${BTN} ${BTN_V[variant]} ${BTN_S[size]} ${full ? "w-full" : ""}`}>
      {busy ? <span aria-hidden="true" className="material-symbols-outlined ep-spin text-[18px]">progress_activity</span> : icon ? <span aria-hidden="true" className="material-symbols-outlined text-[18px]">{icon}</span> : null}
      {children}
    </button>
  );
}
const BADGE: Record<string, string> = {
  default: "bg-surface-2 text-text-muted", primary: "bg-brand-500/10 text-brand-600 dark:text-brand-300",
  success: "bg-green-500/10 text-green-600 dark:text-green-400", warning: "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400", error: "bg-red-500/10 text-red-600 dark:text-red-400",
};
const Badge = ({ children, v = "default", dot }: { children: ReactNode; v?: string; dot?: string }) => (
  <span className={`inline-flex items-center gap-1.5 rounded-full font-semibold ${BADGE[v]} px-2 py-0.5 text-[10px]`}>{dot && <span className={`size-1.5 rounded-full ${dot}`} />}{children}</span>
);
function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}
      className={`relative inline-flex shrink-0 cursor-pointer rounded-full transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-brand-500/30 disabled:cursor-not-allowed disabled:opacity-50 ${on ? "bg-brand-500" : "bg-surface-3"} w-9 h-5`}>
      <span className={`pointer-events-none inline-block rounded-full bg-white shadow-sm transform transition duration-200 ease-in-out ${on ? "translate-x-4" : "translate-x-0.5"} size-4 mt-0.5`} />
    </button>
  );
}
const Card = ({ children, className = "p-6" }: { children: ReactNode; className?: string }) => (
  <div className={`bg-surface border border-border-subtle rounded-[14px] shadow-[var(--shadow-soft)] ${className}`}>{children}</div>
);
const Code = ({ children }: { children: ReactNode }) => <code className="font-mono">{children}</code>;

// ---- Models by maker -------------------------------------------------------------

const MAKERS: [RegExp, string, string][] = [
  [/claude/i, "anthropic", "Anthropic"], [/gpt|^o\d|openai/i, "openai", "OpenAI"], [/gemini|gemma/i, "gemini", "Google"],
  [/deepseek/i, "deepseek", "DeepSeek"], [/kimi|moonshot/i, "kimi", "Moonshot"], [/glm/i, "glm", "Z.ai"], [/minimax/i, "minimax", "MiniMax"],
  [/mimo/i, "xiaomi-mimo", "Xiaomi"], [/mistral|mixtral|devstral|codestral|magistral|ministral/i, "mistral", "Mistral"], [/grok/i, "xai", "xAI"],
];
const makerOf = (id: string) => MAKERS.find(([re]) => re.test(id));

// ---- Types -------------------------------------------------------------------------

export interface EndpointNode extends NodeQuirks {
  id: string;
  name: string;
  prefix?: string;
  type?: string;
  apiType?: string;
  baseUrl?: string;
  icon?: string | null;
  siteIcon?: string | null;
  tint?: string | null;
  modelsNote?: string;
  verified?: boolean;
}
export interface EndpointConnection {
  id: string;
  name?: string;
  isActive?: boolean;
  testStatus?: string;
  lastError?: string | null;
  autoDisabledAt?: string | null;
  autoDisabledReason?: string | null;
  priority?: number;
  providerSpecificData?: { baseUrl?: string; ownBaseUrl?: boolean };
}
interface Props {
  node: EndpointNode;
  connections: EndpointConnection[];
  models: string[];
  disabledIds: string[];
  onToggleModel: (id: string, on: boolean) => Promise<unknown> | unknown;
  onAddModel: (id: string) => Promise<unknown> | unknown;
  onDeleteModel: (id: string) => Promise<unknown> | unknown;
  // Name, prefix and URL; resolves false when the save failed.
  onEditNode: (fields: { name: string; prefix: string; baseUrl: string }) => Promise<boolean>;
  onSaveNode: (quirks: Partial<NodeQuirks>, extra?: StudioExtra) => Promise<unknown> | unknown;
  onReload: () => Promise<unknown> | unknown;
  onAddKey: () => void;
  onEditKey: (c: EndpointConnection) => void;
  onDeleteKey: (id: string) => void;
  onToggleKey: (id: string, on: boolean) => void;
  onDelete: () => void;
  onNodeChanged: (node: EndpointNode) => void;
}

const protoOf = (n: EndpointNode): RouteProtocol =>
  n.type === "anthropic-compatible" ? "anthropic" : n.apiType === "responses" ? "openai-responses" : "openai-chat";
// One badge per API some model uses (Snowflake serves Claude on Messages and GPT
// on Chat Completions from one URL). Unrouted models use the main API.
const protosOf = (n: EndpointNode, main: RouteProtocol, models: string[]): RouteProtocol[] => {
  const routes = n.modelRoutes || {};
  const used = models.map((m) => (routes[m] as RouteProtocol | undefined) || main);
  return [...new Set(used.length ? used : [main])].filter((x): x is RouteProtocol => x in PROTO_LABEL);
};
const PROTO_LABEL: Record<RouteProtocol, string> = { "openai-chat": "OpenAI · Chat Completions", "openai-responses": "OpenAI · Responses", anthropic: "Anthropic · Messages" };

// ---- The page ----------------------------------------------------------------------

export default function CustomEndpointPage(p: Props) {
  const { node, connections, models } = p;
  const mimic = (node.mimic && node.mimic !== "none" ? node.mimic : null) as Mimic | null;
  const who = mimic ? MIMIC_LABELS[mimic] : null;
  const proto = protoOf(node);
  const [iconOpen, setIconOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  // One check at a time: two would double the probes and race on Apply.
  const [checking, setChecking] = useState<RedetectPart | null>(null);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <Link href="/dashboard/providers" className="inline-flex w-max items-center gap-1 text-sm text-text-muted transition-colors hover:text-primary"><span className="material-symbols-outlined text-lg">arrow_back</span>Back to Providers</Link>
        <div className="flex items-center gap-4">
          <button type="button" onClick={() => setIconOpen(true)} aria-label="Change icon" className="group relative rounded-[14px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
            <EndpointIcon icon={node.icon} name={node.name} tint={node.tint} size={56} impersonating={who} />
            <span className="absolute -bottom-1 -right-1 flex size-6 items-center justify-center rounded-full border border-border-subtle bg-surface text-text-muted shadow-sm group-hover:text-text-main"><span className="material-symbols-outlined text-[14px]">edit</span></span>
          </button>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-3xl font-semibold tracking-tight">{node.name}</h1>
              <button type="button" onClick={() => setEditOpen(true)} aria-label="Edit name, prefix and URL" title="Edit name, prefix and URL" className="material-symbols-outlined rounded p-1 text-[18px] text-text-muted hover:bg-surface-2 hover:text-text-main">edit</button>
            </div>
            <p className="text-text-muted">{connections.length} key{connections.length === 1 ? "" : "s"} · {models.length} model{models.length === 1 ? "" : "s"}</p>
          </div>
        </div>
      </div>

      <EndpointCard {...p} proto={proto} checking={checking} setChecking={setChecking} />
      <KeysCard {...p} />
      <ModelsCard {...p} checking={checking} setChecking={setChecking} />
      {/* Advanced (lane dialog-advanced): mounted last, as in the mockup. */}
      <EndpointAdvancedStudio node={node} onSave={p.onSaveNode} model={models[0]} detected={proto} canChangeProtocol={proto !== "anthropic"} />

      {iconOpen && <IconModal node={node} onClose={() => setIconOpen(false)} onSaved={p.onNodeChanged} />}
      {editOpen && <EditModal node={node} onClose={() => setEditOpen(false)} onSave={p.onEditNode} />}
    </div>
  );
}

// ---- Endpoint card + Recent requests ------------------------------------------------

type Checking = { checking: RedetectPart | null; setChecking: (p: RedetectPart | null) => void };
function EndpointCard({ node, connections, models, proto, onReload, onDelete, onNodeChanged, checking, setChecking }: Props & Checking & { proto: RouteProtocol }) {
  const [log, setLog] = useState<EndpointRequestEntry[]>([]);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState("");
  const rd = useRedetect(node.id, "endpoint", setChecking);
  const seen = useRef<Set<string> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/providers/${node.id}/requests`, { cache: "no-store" });
      const d = (await res.json()) as { requests?: EndpointRequestEntry[] };
      const list = d.requests || [];
      // Animate only rows that weren't there before (first load: none).
      if (seen.current) setFresh(new Set(list.filter((r) => !seen.current!.has(r.id)).map((r) => r.id)));
      seen.current = new Set(list.map((r) => r.id));
      setLog(list);
    } catch { /* keep what we have */ }
  }, [node.id]);
  // Poll while the page is visible: the router logs traffic from every client.
  useEffect(() => {
    void load();
    const t = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 5000);
    return () => clearInterval(t);
  }, [load]);

  const test = async () => {
    setTesting(true); setTestError("");
    try {
      const res = await fetch(`/api/providers/${node.id}/requests`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const d = (await res.json()) as { ok?: boolean; error?: string | null; requests?: EndpointRequestEntry[] };
      if (!d.ok) setTestError(d.error || "Test failed");
      await load();
    } catch { setTestError("Network error"); }
    finally { setTesting(false); }
  };

  const url = (node.baseUrl || "").replace(/\/+$/, "");
  return (
    <>
      <Card>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2"><h2 className="text-lg font-semibold">Endpoint</h2>{protosOf(node, proto, models).map((pr) => <Badge key={pr} v={node.verified === false ? "warning" : "success"}>{PROTO_LABEL[pr]}</Badge>)}</div>
            <p className="mt-1 font-mono text-sm text-text-muted [overflow-wrap:anywhere]">{url.split("/").map((s, i, a) => <span key={i}>{s}{i < a.length - 1 && <>/<wbr /></>}</span>)}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Btn icon="send" variant="secondary" title="May cost a few tokens" busy={testing} disabled={testing || !connections.length || !models.length} onClick={test}>Send test message</Btn>
            <Btn icon="bolt" variant="secondary" title="Re-check which API, URL and fixes it needs. Models have their own check below." busy={rd.detecting} disabled={!!checking} onClick={rd.run}>Re-detect</Btn>
            <Btn icon="delete" variant="secondary" onClick={onDelete}>Delete</Btn>
          </div>
        </div>
        {rd.detecting && <RedetectStatus live={rd.live} onStop={rd.stop} />}
        {(!connections.length || !models.length) && <p className="mt-3 text-xs text-text-muted">{!connections.length ? "Add a key to send a test message." : "Add a model to send a test message."}</p>}
        {testError && <p role="alert" className="ep-in mt-3 text-xs text-red-600 dark:text-red-400">{testError}</p>}
        {rd.result && <RedetectBox node={node} part="endpoint" diff={rd.result} onClose={rd.clear} onApplied={async (n) => { if (n) onNodeChanged(n); rd.clear(); await onReload(); }} />}
      </Card>
      {log.length > 0 && (
        <Card>
          <div className="mb-3 flex items-center justify-between"><h2 className="text-lg font-semibold">Recent requests</h2><span className="text-xs text-text-muted">key redacted</span></div>
          <ul className="flex flex-col gap-1.5">{log.map((l) => <LogRow key={l.id} l={l} fresh={fresh.has(l.id)} />)}</ul>
        </Card>
      )}
    </>
  );
}

// One request: a summary line that opens to the exact request and response.
function LogRow({ l, fresh }: { l: EndpointRequestEntry; fresh: boolean }) {
  const isFix = l.kind === "fix";
  const iconName = isFix ? "auto_fix_high" : l.ok ? "check_circle" : "cancel";
  const iconCls = l.ok ? "text-green-500" : isFix ? "text-brand-500" : "text-text-subtle";
  const model = <code className="font-mono">{l.model || "model"}</code>;
  const prompt = l.prompt ? `"${l.prompt}"` : "Request";
  const flags = (l.flags || []).map((f, i) => <span key={f}>{i ? ", " : ""}<code className="font-mono">{f}</code></span>);
  const text: ReactNode = isFix
    ? <>Dropped {flags}. Will leave {(l.flags || []).length === 1 ? "it" : "them"} out from now on</>
    : l.ok
      ? <>{prompt} to {model}</>
      : <>{prompt} to {model}{l.error && <>: <span className="text-text-subtle">{l.error}</span></>}</>;
  const head = (
    <>
      <span aria-hidden="true" className={`material-symbols-outlined text-[16px] ${iconCls}`}>{iconName}</span>
      <span className={`min-w-0 flex-1 ${l.ok ? "text-text-main" : "text-text-muted"}`}>{text}</span>
      <span className="shrink-0 font-mono text-text-subtle">{isFix ? l.note : l.ok ? l.note : l.status || "—"}</span>
    </>
  );
  if (!l.request) return <li className={`flex items-start gap-2 rounded-[10px] bg-surface-2 px-3 py-2 text-xs ${fresh ? "ep-in" : ""}`}>{head}</li>;
  const pre = (t: string) => <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-[8px] bg-surface p-2.5 font-mono text-[11px] leading-relaxed text-text-main">{t}</pre>;
  return (
    <li className={fresh ? "ep-in" : ""}>
      <details className="group rounded-[10px] bg-surface-2">
        <summary className="flex cursor-pointer list-none items-start gap-2 px-3 py-2 text-xs">{head}<span aria-hidden="true" className="material-symbols-outlined text-[16px] text-text-subtle transition-transform group-open:rotate-90">chevron_right</span></summary>
        <div className="grid gap-2 px-3 pb-3 md:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-1"><p className="text-[11px] font-medium text-text-muted">Request</p>{pre(l.request)}</div>
          <div className="flex min-w-0 flex-col gap-1"><p className="text-[11px] font-medium text-text-muted">Response</p>{pre(l.response || "")}</div>
        </div>
      </details>
    </li>
  );
}

// One run of Re-detect for one half of the page, with its live progress.
// Leaving the page stops the run, so the server stops probing too.
function useRedetect(nodeId: string, part: RedetectPart, setChecking: (p: RedetectPart | null) => void) {
  const [result, setResult] = useState<(RedetectDiff & { usedKey?: boolean }) | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [live, setLive] = useState<RedetectLive>(LIVE0);
  const stopRef = useRef<AbortController | null>(null);
  useEffect(() => () => stopRef.current?.abort(), []);
  const run = async () => {
    const stop = new AbortController();
    stopRef.current = stop;
    setDetecting(true); setChecking(part); setResult(null); setLive({ ...LIVE0, startedAt: Date.now() });
    const failed = (error: string): RedetectDiff => ({ ok: false, error, protocol: null, baseUrl: null, addModels: [], removeModels: [], outdatedModels: [], quirks: {}, modelsNote: null, changes: 0 });
    try {
      const res = await fetch(`/api/providers/${nodeId}/redetect?part=${part}`, { method: "POST", headers: { Accept: "application/x-ndjson" }, signal: stop.signal });
      setResult(await readNdjson<RedetectDiff>(res, (e) => setLive((l) => nextLive(l, e))));
    } catch { setResult(stop.signal.aborted ? null : failed("Network error")); }
    finally { setDetecting(false); setChecking(null); stopRef.current = null; }
  };
  const clear = useCallback(() => setResult(null), []);
  return { result, detecting, live, run, stop: () => stopRef.current?.abort(), clear };
}

// Live progress while Re-detect runs, in plain words.
interface RedetectLive { startedAt: number; doing: string; sent: number; checked: number; total: number; found: number; waitUntil: number }
const LIVE0: RedetectLive = { startedAt: 0, doing: "Connecting to the endpoint", sent: 0, checked: 0, total: 0, found: 0, waitUntil: 0 };
function nextLive(l: RedetectLive, e: DetectProgress): RedetectLive {
  const sent = "sent" in e && typeof e.sent === "number" ? Math.max(l.sent, e.sent) : l.sent;
  switch (e.type) {
    case "request": {
      const doing = /models/i.test(e.label) && e.method === "GET" ? "Asking for its model list"
        : /bad-key/i.test(e.label) ? "Making sure it really checks the key"
        : /made-up|control/i.test(e.label) ? "Double-checking what it answered"
        : "Checking which APIs it speaks";
      return { ...l, sent: Math.max(sent, l.sent + 1), doing, checked: 0, total: 0, found: 0 };
    }
    case "throttled": return { ...l, sent, waitUntil: Date.now() + e.waitMs };
    case "models-start": return { ...l, sent, doing: `Checking models on ${PROTOCOL_NAME[e.protocol as keyof typeof PROTOCOL_NAME] || e.protocol}`, checked: 0, total: e.total, found: 0 };
    case "models-done": return { ...l, sent, total: 0 };
    case "probe-result": return { ...l, sent, checked: l.checked + (e.skipped ? 0 : 1), found: l.found + (e.known ? 1 : 0) };
    default: return { ...l, sent };
  }
}

function RedetectStatus({ live, onStop }: { live: RedetectLive; onStop: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, []);
  const secs = Math.max(0, Math.round((now - live.startedAt) / 1000));
  const wait = Math.ceil((live.waitUntil - now) / 1000);
  return (
    <div className="ep-in mt-4 flex items-start gap-2 rounded-[10px] border border-border-subtle bg-surface-2 px-3 py-2.5 text-xs">
      <span aria-hidden="true" className="material-symbols-outlined ep-spin text-[16px] text-brand-500">progress_activity</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p role="status" aria-live="polite" className="font-medium text-text-main">{live.doing}{live.total > 0 && `: ${live.checked} of ${live.total}, ${live.found} work`}</p>
        <p className="text-text-muted">{wait > 0 ? `Rate-limited, waiting ${wait}s · ` : ""}{live.sent} request{live.sent === 1 ? "" : "s"} · {secs}s · uses free checks where it can</p>
      </div>
      <Btn variant="ghost" onClick={onStop}>Stop</Btn>
    </div>
  );
}

// What Re-detect found, as changes to tick and apply.
function RedetectBox({ node, part, diff, onClose, onApplied }: { node: EndpointNode; part: RedetectPart; diff: RedetectDiff & { usedKey?: boolean }; onClose: () => void; onApplied: (n: EndpointNode | null) => Promise<void> }) {
  const [pick, setPick] = useState({ protocol: !!diff.protocol?.applicable, baseUrl: !!diff.baseUrl, add: !!diff.ok && diff.addModels.length > 0, remove: !!diff.ok && diff.removeModels.length > 0, outdated: false, quirks: true });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  if (!diff.ok) {
    return (
      <div role="alert" className="ep-in mt-4 flex items-start gap-2 rounded-[10px] border border-red-500/30 bg-red-500/5 px-3 py-2.5 text-xs">
        <span aria-hidden="true" className="material-symbols-outlined text-[16px] text-red-500">error</span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5"><p className="font-medium text-text-main">{part === "models" ? "The model check" : "Re-detect"} didn&apos;t get through</p><p className="text-text-muted">{diff.error}. Nothing was changed.</p></div>
        <button type="button" onClick={onClose} aria-label="Dismiss" className="material-symbols-outlined text-[16px] text-text-muted hover:text-text-main">close</button>
      </div>
    );
  }
  const q = diff.quirks;
  const qList = [q.maxCompletionTokens && "send max_completion_tokens", q.apiKeyHeader && "send the key in an api-key header", q.modelRoutes && Object.keys(q.modelRoutes).length > 0 && "send each model to the API that answers it"].filter(Boolean) as string[];
  // Ticked rows that exist; a lone "needs a new endpoint" note has nothing to apply.
  const applicable = (pick.protocol && !!diff.protocol?.applicable) || (pick.baseUrl && !!diff.baseUrl) || (pick.add && diff.addModels.length > 0) || (pick.remove && diff.removeModels.length > 0) || (pick.outdated && diff.outdatedModels.length > 0) || (pick.quirks && qList.length > 0);
  const apply = async () => {
    setSaving(true); setErr("");
    try {
      const body: Record<string, unknown> = {};
      // The note describes the import, so it only changes when the models do.
      if (pick.add && diff.addModels.length && diff.modelsNote) body.modelsNote = diff.modelsNote;
      if (pick.protocol && diff.protocol?.applicable) body.apiType = diff.protocol.to === "openai-responses" ? "responses" : "chat";
      if (pick.baseUrl && diff.baseUrl) body.baseUrl = diff.baseUrl.to;
      if (pick.add && diff.addModels.length) body.addModels = diff.addModels;
      const removing = [...(pick.remove ? diff.removeModels : []), ...(pick.outdated ? diff.outdatedModels : [])];
      if (removing.length) body.removeModels = removing;
      if (pick.quirks && qList.length) body.quirks = q;
      const res = await fetch(`/api/providers/${node.id}/redetect`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = (await res.json().catch(() => ({}))) as { node?: EndpointNode; error?: string; failed?: number };
      if (!res.ok) { setErr(d.error || `HTTP ${res.status}`); return; }
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("customModelChanged"));
      if (d.failed) { setErr(`Applied, but ${d.failed} model change${d.failed === 1 ? "" : "s"} failed. Check again to retry them.`); return; }
      await onApplied(d.node || null);
    } catch { setErr("Network error"); }
    finally { setSaving(false); }
  };
  const row = (k: keyof typeof pick, children: ReactNode) => (
    <label className="flex cursor-pointer items-start gap-2 text-xs text-text-main">
      <input type="checkbox" checked={pick[k]} onChange={(e) => setPick({ ...pick, [k]: e.target.checked })} className="mt-0.5 size-3.5 accent-[var(--color-brand-500,#e11d74)]" />
      <span className="min-w-0">{children}</span>
    </label>
  );
  const chips = (ids: string[]) => <span className="mt-1 flex flex-wrap gap-1">{ids.slice(0, 12).map((m) => <span key={m} className="rounded-full border border-border-subtle bg-surface px-2 py-0.5 text-[11px] text-text-muted">{prettyModel(m)}</span>)}{ids.length > 12 && <span className="text-[11px] text-text-subtle">+{ids.length - 12} more</span>}</span>;
  return (
    <div className="ep-in mt-4 flex flex-col gap-3 rounded-[10px] border border-border-subtle bg-surface-2 p-3">
      <div className="flex items-start gap-2">
        <span aria-hidden="true" className={`material-symbols-outlined text-[16px] ${diff.changes ? "text-brand-500" : "text-green-500"}`}>{diff.changes ? "bolt" : "check_circle"}</span>
        <div className="min-w-0 flex-1 text-xs">
          <p className="font-medium text-text-main">{diff.changes ? `Found ${diff.changes} change${diff.changes === 1 ? "" : "s"}` : "Nothing changed"}</p>
          <p className="text-text-muted">{diff.changes ? "Pick what to apply. Free probes only, nothing was generated." : `${part === "models" ? "Same models as you have now." : part === "endpoint" ? "No changes to the API, URL or fixes." : "Same API, URL and models as when it was added."}${diff.usedKey === false ? " No key, so only what's public was checked." : ""}`}</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Dismiss" className="material-symbols-outlined text-[16px] text-text-muted hover:text-text-main">close</button>
      </div>
      {diff.changes > 0 && (
        <div className="flex flex-col gap-2 pl-6">
          {diff.protocol && (diff.protocol.applicable
            ? row("protocol", <>API: {PROTO_LABEL[diff.protocol.from]} → <span className="font-medium">{PROTO_LABEL[diff.protocol.to]}</span></>)
            : <p className="text-xs text-text-muted">It now answers as {PROTO_LABEL[diff.protocol.to]}. Switching between OpenAI and Anthropic needs a new endpoint: add it again from Providers.</p>)}
          {diff.baseUrl && row("baseUrl", <>URL: <Code>{diff.baseUrl.from}</Code> → <Code>{diff.baseUrl.to}</Code></>)}
          {diff.addModels.length > 0 && row("add", <>Add {diff.addModels.length} new model{diff.addModels.length === 1 ? "" : "s"}{chips(diff.addModels)}</>)}
          {diff.removeModels.length > 0 && row("remove", <>Remove {diff.removeModels.length} model{diff.removeModels.length === 1 ? "" : "s"} that {diff.removeModels.length === 1 ? "is" : "are"} no longer listed{chips(diff.removeModels)}</>)}
          {diff.outdatedModels.length > 0 && row("outdated", <>Remove {diff.outdatedModels.length} older model{diff.outdatedModels.length === 1 ? "" : "s"} with newer versions out{chips(diff.outdatedModels)}</>)}
          {qList.length > 0 && row("quirks", <>Fixes: {qList.join(", ")}</>)}
          {err && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{err}</p>}
          <div className="flex gap-2 pt-1"><Btn icon="check" busy={saving} disabled={saving || !applicable} onClick={apply}>Apply</Btn><Btn variant="ghost" onClick={onClose}>Keep as is</Btn></div>
        </div>
      )}
    </div>
  );
}

// ---- Keys --------------------------------------------------------------------------

function KeysCard({ connections, onAddKey, onEditKey, onDeleteKey, onToggleKey, onReload }: Props) {
  const [testing, setTesting] = useState(false);
  const [results, setResults] = useState<Record<string, "testing" | "ok" | "failed">>({});
  const testable = connectionsToTest(connections);
  const testAll = async () => {
    setTesting(true);
    for (const c of testable) {
      setResults((r) => ({ ...r, [c.id]: "testing" }));
      try {
        const res = await fetch(`/api/providers/${c.id}/test`, { method: "POST" });
        const d = (await res.json()) as { valid?: boolean };
        setResults((r) => ({ ...r, [c.id]: d.valid ? "ok" : "failed" }));
      } catch { setResults((r) => ({ ...r, [c.id]: "failed" })); }
    }
    setTesting(false);
    await onReload();
  };
  return (
    <Card>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-lg font-semibold">Keys</h2>
        <div className="flex gap-2">
          <Btn icon="sync" variant="secondary" busy={testing} disabled={testing || !testable.length} onClick={testAll}>Test all</Btn>
          <Btn icon="add" onClick={onAddKey}>Add key</Btn>
        </div>
      </div>
      {connections.length === 0 ? (
        <p className="text-sm text-text-muted">No keys yet. Add one to start sending requests.</p>
      ) : (
        <div className="flex min-w-0 flex-col divide-y divide-black/[0.03] dark:divide-white/[0.03]">
          {connections.map((k, i) => {
            const r = results[k.id];
            const off = k.isActive === false;
            const status = r === "testing" ? <Badge v="primary">testing</Badge>
              : off ? <Badge dot="bg-text-muted">disabled</Badge>
              : (r === "ok" || (!r && k.testStatus === "active")) ? <Badge v="success" dot="bg-green-500">active</Badge>
              : (r === "failed" || (!r && (k.testStatus === "error" || k.testStatus === "expired"))) ? <Badge v="error" dot="bg-red-500">{k.testStatus === "expired" ? "expired" : "failed"}</Badge>
              : <Badge v="warning" dot="bg-yellow-500">unverified</Badge>;
            const own = k.providerSpecificData?.ownBaseUrl ? (() => { try { return new URL(k.providerSpecificData!.baseUrl || "").host; } catch { return ""; } })() : "";
            const masked = /…/.test(k.name || "");
            return (
              <div key={k.id} className={`group flex min-w-0 flex-col gap-3 rounded-lg p-2 transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.02] sm:flex-row sm:items-center sm:justify-between ${off ? "opacity-60" : ""}`}>
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <span className="material-symbols-outlined shrink-0 text-base text-text-muted">key</span>
                  <div className="min-w-0 flex-1">
                    <p className={`block truncate text-sm font-medium ${masked ? "font-mono" : ""}`}>{k.name || "key"}</p>
                    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 sm:gap-2">
                      {status}
                      <Badge>API Key</Badge>
                      {own && <span className="truncate text-[11px] text-text-muted">{own}</span>}
                      {k.lastError && !off && <span className="max-w-full truncate text-xs text-red-500 sm:max-w-[300px]" title={k.lastError}>{k.lastError}</span>}
                      {off && k.autoDisabledAt && <span className="max-w-full truncate text-xs text-red-500 sm:max-w-[360px]" title={`Turned off automatically ${new Date(k.autoDisabledAt).toLocaleString()}: ${k.autoDisabledReason || ""}`}>Turned off automatically: {k.autoDisabledReason}</span>}
                      <span className="text-xs text-text-muted">#{i + 1}</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button type="button" onClick={() => onEditKey(k)} className="flex flex-col items-center rounded px-2 py-1 text-text-muted hover:bg-black/5 hover:text-primary dark:hover:bg-white/5"><span className="material-symbols-outlined text-[18px]">edit</span><span className="text-[10px]">Edit</span></button>
                  <button type="button" onClick={() => onDeleteKey(k.id)} className="flex flex-col items-center rounded px-2 py-1 text-red-500 hover:bg-red-500/10"><span className="material-symbols-outlined text-[18px]">delete</span><span className="text-[10px]">Delete</span></button>
                  <span className="ml-1"><Toggle on={!off} label={`${off ? "Enable" : "Disable"} ${k.name || "key"}`} onChange={(v) => onToggleKey(k.id, v)} /></span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

// ---- Models ------------------------------------------------------------------------

function ModelsCard({ node, models, disabledIds, onToggleModel, onAddModel, onDeleteModel, onReload, onNodeChanged, checking, setChecking }: Props & Checking) {
  const rd = useRedetect(node.id, "models", setChecking);
  // A result found before the API switched would route models against the old one.
  const { clear } = rd;
  useEffect(() => { clear(); }, [node.type, node.apiType, clear]);
  const [adding, setAdding] = useState(false);
  const [newId, setNewId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const disabled = new Set(disabledIds);
  const prefix = node.prefix || node.id;
  const groups = new Map<string, { logo?: string; ids: string[] }>();
  for (const m of models) {
    const mk = makerOf(m);
    const k = mk?.[2] || "Other";
    if (!groups.has(k)) groups.set(k, { logo: mk?.[1], ids: [] });
    groups.get(k)!.ids.push(m);
  }
  const row = (m: string) => {
    const mk = makerOf(m);
    const on = !disabled.has(m);
    return (
      <div key={m} className={`flex items-center justify-between gap-3 py-2 ${on ? "" : "opacity-60"}`}>
        <div className="flex min-w-0 items-center gap-3">
          {mk
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={`/providers/${mk[1]}.png`} alt="" title={mk[2]} className="size-7 shrink-0 rounded-[8px] border border-border-subtle bg-white object-contain p-1" />
            : <span className="flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-surface-2 text-[11px] font-semibold text-text-muted">{(m.split("/").pop() || m)[0].toUpperCase()}</span>}
          <div className="min-w-0"><p className="truncate text-sm font-medium text-text-main">{prettyModel(m)}</p><code className="block truncate font-mono text-[11px] text-text-subtle">{prefix}/{m}</code></div>
        </div>
        <span className="flex items-center gap-2 text-xs text-text-subtle">
          <button type="button" disabled={busy === m} aria-label={`Remove ${prettyModel(m)}`} title="Remove" onClick={async () => { setBusy(m); try { await onDeleteModel(m); } finally { setBusy(null); } }} className="material-symbols-outlined rounded p-0.5 text-[16px] text-text-subtle hover:bg-surface-2 hover:text-red-500 disabled:opacity-50">delete</button>
          <Toggle on={on} disabled={busy === m} label={`${on ? "Turn off" : "Turn on"} ${prettyModel(m)}`} onChange={async (v) => { setBusy(m); try { await onToggleModel(m, v); } finally { setBusy(null); } }} />
        </span>
      </div>
    );
  };
  const add = async () => {
    const id = newId.trim();
    if (!id) return;
    setBusy("__add"); try { if ((await onAddModel(id)) !== false) { setNewId(""); setAdding(false); } } finally { setBusy(null); }
  };
  return (
    <Card>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Models</h2>
        <div className="flex items-center gap-3">
          <span className="text-xs text-text-muted">{node.modelsNote || "imported from /models"}</span>
          <button type="button" onClick={rd.run} disabled={!!checking} aria-busy={rd.detecting} aria-label="Check for new models" title="Check for new models (free checks only)" className="flex rounded p-0.5 text-text-muted hover:bg-surface-2 hover:text-text-main disabled:opacity-50 disabled:hover:bg-transparent"><span aria-hidden="true" className={`material-symbols-outlined text-[18px] ${rd.detecting ? "ep-spin" : ""}`}>{rd.detecting ? "progress_activity" : "refresh"}</span></button>
          <button type="button" onClick={() => setAdding((v) => !v)} aria-label="Add a model by ID" title="Add a model by ID" className="material-symbols-outlined rounded p-0.5 text-[18px] text-text-muted hover:bg-surface-2 hover:text-text-main">add</button>
        </div>
      </div>
      {rd.detecting && <div className="mb-3 -mt-2"><RedetectStatus live={rd.live} onStop={rd.stop} /></div>}
      {rd.result && <div className="mb-3 -mt-2"><RedetectBox node={node} part="models" diff={rd.result} onClose={rd.clear} onApplied={async (n) => { if (n) onNodeChanged(n); rd.clear(); await onReload(); }} /></div>}
      {adding && (
        <div className="ep-in mb-3 flex items-end gap-2">
          <div className="min-w-0 flex-1"><Input id="ep-add-model" label="Model ID" value={newId} autoFocus placeholder={protoOf(node) === "anthropic" ? "claude-haiku-4-5" : "gpt-5-mini"} onChange={(e) => setNewId(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void add(); }} /></div>
          <Btn size="md" icon="add" busy={busy === "__add"} disabled={!newId.trim() || busy === "__add"} onClick={add}>Add</Btn>
        </div>
      )}
      <div className="flex flex-col divide-y divide-black/[0.03] dark:divide-white/[0.03]">
        {models.length === 0
          ? <p className="text-sm text-text-muted">No models yet. Once the key works, press the refresh button above to find them, or add one by ID.</p>
          : groups.size < 2
            ? models.map(row)
            : [...groups].map(([maker, g]) => (
              <div key={maker} className="flex flex-col divide-y divide-black/[0.03] dark:divide-white/[0.03]">
                <p className="pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-text-subtle">{maker} · {g.ids.length}</p>
                {g.ids.map(row)}
              </div>
            ))}
      </div>
    </Card>
  );
}

// ---- Name, prefix and URL ---------------------------------------------------------

function EditModal({ node, onClose, onSave }: { node: EndpointNode; onClose: () => void; onSave: Props["onEditNode"] }) {
  const [name, setName] = useState(node.name);
  const [prefix, setPrefix] = useState(node.prefix || "");
  const [baseUrl, setBaseUrl] = useState(node.baseUrl || "");
  const [busy, setBusy] = useState(false);
  const ready = name.trim() && prefix.trim() && baseUrl.trim();
  const save = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try { if (await onSave({ name: name.trim(), prefix: prefix.trim(), baseUrl: baseUrl.trim() })) onClose(); } finally { setBusy(false); }
  };
  const enter = (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") void save(); };
  return (
    <Modal isOpen title="Edit endpoint" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <Input id="ep-edit-name" label="Name" value={name} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={enter} />
        <Input id="ep-edit-prefix" label="Prefix" value={prefix} hint={<>Models are called as <Code>{prefix || "prefix"}/model</Code>. Changing it breaks clients using the old one.</>} onChange={(e) => setPrefix(e.target.value)} onKeyDown={enter} />
        <Input id="ep-edit-url" label="Base URL" value={baseUrl} placeholder="https://…/v1" onChange={(e) => setBaseUrl(e.target.value)} onKeyDown={enter} />
        <div className="flex justify-end gap-2"><Btn variant="ghost" onClick={onClose}>Cancel</Btn><Btn icon="check" busy={busy} disabled={!ready || busy} onClick={save}>Save</Btn></div>
      </div>
    </Modal>
  );
}

// ---- Icon picker -------------------------------------------------------------------

function IconModal({ node, onClose, onSaved }: { node: EndpointNode; onClose: () => void; onSaved: (n: EndpointNode) => void }) {
  const [site, setSite] = useState<string | null>(node.siteIcon ?? null);
  const [looking, setLooking] = useState(true);
  const [host, setHost] = useState(() => { try { return new URL(node.baseUrl || "").hostname; } catch { return node.baseUrl || ""; } });
  const [url, setUrl] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const found = site;

  // Always looks again: a saved site icon may be an old 32px favicon.
  useEffect(() => {
    let cancel = false;
    fetch(`/api/providers/${node.id}/redetect/icon`).then((r) => r.json()).then(async (d: { site?: { icon?: string | null; host?: string } | null }) => {
      // Shrunk like the saved copy, so an unchanged site icon still matches node.icon.
      const icon = d.site?.icon ? await shrinkIcon(d.site.icon) : null;
      if (cancel) return;
      if (icon) setSite(icon);
      if (d.site?.host) setHost(d.site.host);
    }).catch(() => {}).finally(() => { if (!cancel) setLooking(false); });
    return () => { cancel = true; };
  }, [node.id]);

  // Resolves true once the icon is saved; on failure it shows the error and resolves false.
  const save = async (patch: { icon?: string | null; tint?: string | null }): Promise<boolean> => {
    setBusy(true); setErr("");
    try {
      const small = { ...patch, ...(patch.icon && patch.icon !== found ? { icon: await shrinkIcon(patch.icon) } : {}), ...(found && found !== node.siteIcon ? { siteIcon: found } : {}) };
      const res = await fetch(`/api/providers/${node.id}/redetect/icon`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(small) });
      const d = (await res.json().catch(() => ({}))) as { node?: EndpointNode; error?: string };
      if (!res.ok || !d.node) { setErr(d.error || "Couldn't save the icon"); return false; }
      onSaved(d.node);
      return true;
    } catch { setErr("Network error"); return false; }
    finally { setBusy(false); }
  };
  const fromUrl = async (): Promise<boolean> => {
    const u = url.trim();
    if (!u) return false;
    setBusy(true); setErr("");
    try {
      const res = await fetch(`/api/providers/${node.id}/redetect/icon`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: u }) });
      const d = (await res.json().catch(() => ({}))) as { icon?: string; error?: string };
      if (!res.ok || !d.icon) { setErr(d.error || "Couldn't use that image"); setBusy(false); return false; }
      const ok = await save({ icon: d.icon });
      if (ok) setUrl("");
      return ok;
    } catch { setErr("Network error"); setBusy(false); return false; }
  };
  const upload = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (f.size > 256 * 1024) { setErr("Images up to 256 KB"); return; }
    if (!/^image\/(png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon)$/.test(f.type)) { setErr("PNG, JPEG, GIF, WebP or ICO"); return; }
    const r = new FileReader();
    r.onload = () => void save({ icon: String(r.result).replace(/^data:image\/vnd\.microsoft\.icon/, "data:image/x-icon") });
    r.readAsDataURL(f);
  };
  const isUpload = !!node.icon && node.icon !== found;
  const opt = (label: string, preview: ReactNode, on: boolean, onClick: () => void, disabled = false) => (
    <button type="button" aria-pressed={on} disabled={disabled || busy} onClick={onClick} className={`flex flex-col items-center gap-2 rounded-[12px] border p-3 text-xs transition-colors disabled:opacity-50 ${on ? "border-primary bg-primary/5 text-text-main" : "border-border-subtle text-text-muted hover:text-text-main"}`}>{preview}<span>{label}</span></button>
  );
  return (
    <Modal isOpen title="Icon" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-3 gap-2">
          {found
            ? opt("From site", <EndpointIcon icon={found} name={node.name} size={48} />, node.icon === found, () => void save({ icon: found }))
            : opt(looking ? "Looking…" : "No site icon", <span className="flex size-12 items-center justify-center rounded-[11px] border border-dashed border-border text-text-muted"><span className={`material-symbols-outlined ${looking ? "ep-spin" : ""}`}>{looking ? "progress_activity" : "public"}</span></span>, false, () => {}, true)}
          {opt("Letter", <EndpointIcon name={node.name} tint={node.tint} size={48} />, !node.icon, () => void save({ icon: null }))}
          <label htmlFor={`${node.id}-icon-file`} aria-disabled={busy} className={`flex cursor-pointer flex-col items-center gap-2 rounded-[12px] border p-3 text-xs transition-colors focus-within:ring-2 focus-within:ring-primary/60 ${isUpload ? "border-primary bg-primary/5 text-text-main" : "border-border-subtle text-text-muted hover:text-text-main"}`}><span className="flex size-12 items-center justify-center rounded-[11px] border border-dashed border-border text-text-muted"><span className="material-symbols-outlined">upload</span></span><span>Upload</span></label>
        </div>
        {!node.icon && (
          <div className="flex items-center gap-2">
            {TILE_BG.map((c) => <button key={c} type="button" disabled={busy} onClick={() => void save({ tint: c })} aria-label={`Colour ${c}`} className={`size-6 rounded-full ring-offset-2 ring-offset-surface ${(node.tint || "") === c ? "ring-2 ring-primary" : ""}`} style={{ background: c }} />)}
          </div>
        )}
        <Input id="icon-url" label="Or paste an image URL" icon="image" value={url} placeholder="https://…/icon.png" onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void fromUrl(); }} />
        <p className="text-xs text-text-muted">{found ? `We fetched ${host}'s app icon automatically. Square images look best.` : looking ? `Looking for ${host}'s app icon…` : `${host} has no app icon we could use. Square images look best.`}</p>
        {err && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{err}</p>}
        <input id={`${node.id}-icon-file`} type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/x-icon" className="sr-only" disabled={busy} onChange={upload} />
        <Btn size="md" full busy={busy} onClick={() => { if (!url.trim()) { onClose(); return; } void fromUrl().then((ok) => { if (ok) onClose(); }); }}>Done</Btn>
      </div>
    </Modal>
  );
}
