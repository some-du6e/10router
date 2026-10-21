"use client";

// Pieces of the Add endpoint dialog: the live request list, the result boxes,
// the "Two for one" tiles and the copy for each failure. Layout, wording and
// class strings follow the approved mockup (mockups/provider-setup/src/app.js).

import type { ReactNode, MouseEvent } from "react";
import type { Classification, DetectStep, ModelCheck, Protocol, StopReason } from "@/lib/endpointDetect.js";

export const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
export const reduceMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export const PROTOCOL_LABEL: Record<Protocol, string> = {
  anthropic: "Anthropic · Messages",
  "openai-chat": "OpenAI · Chat Completions",
  "openai-responses": "OpenAI · Responses",
};
export const PROTOCOL_NAME: Record<Protocol, string> = {
  anthropic: "Anthropic Messages",
  "openai-chat": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
};
export const SHORT: Record<Protocol, string> = { anthropic: "Messages", "openai-chat": "Chat", "openai-responses": "Responses" };

// ---- Small shared bits ---------------------------------------------------------

export const Spinner = ({ className = "text-text-muted" }: { className?: string }) => (
  <span className={`material-symbols-outlined ep-spin text-[16px] ${className}`} aria-hidden="true">progress_activity</span>
);

export const Chip = ({ children, title }: { children: ReactNode; title?: string }) => (
  <span title={title} className="rounded-full border border-border-subtle bg-surface px-2 py-0.5 font-mono text-[11px] text-text-muted">{children}</span>
);

const BADGE: Record<string, string> = {
  default: "bg-surface-2 text-text-muted",
  success: "bg-green-500/10 text-green-600 dark:text-green-400",
};
export const Badge = ({ children, variant = "default" }: { children: ReactNode; variant?: string }) => (
  <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold ${BADGE[variant] || BADGE.default}`}>{children}</span>
);

const BTN = "inline-flex items-center justify-center gap-2 font-semibold transition-all duration-150 ease-out cursor-pointer active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100";
const BTN_V: Record<string, string> = {
  primary: "bg-brand-500 hover:bg-brand-600 text-white shadow-sm disabled:bg-surface-3 disabled:text-text-muted",
  secondary: "bg-surface-2 hover:bg-surface-3 text-text-main border border-border disabled:opacity-50",
  ghost: "text-text-muted hover:bg-surface-2 hover:text-text-main",
};
const BTN_S: Record<string, string> = { sm: "h-7 px-3 text-xs rounded-[8px]", md: "h-9 px-4 text-sm rounded-[10px]" };
interface BtnProps { children: ReactNode; icon?: string; variant?: string; size?: string; full?: boolean; disabled?: boolean; busy?: boolean; onClick?: () => void; className?: string }
export function Btn({ children, icon, variant = "primary", size = "md", full, disabled, busy, onClick, className = "" }: BtnProps) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`${BTN} ${BTN_V[variant]} ${BTN_S[size]} ${full ? "w-full" : ""} ${className}`}>
      {busy ? <Spinner className="" /> : icon ? <span className="material-symbols-outlined text-[18px]" aria-hidden="true">{icon}</span> : null}
      {children}
    </button>
  );
}

// ---- Eased <details> -------------------------------------------------------------
// Native <details> snaps open and shut; this eases its height instead (the
// dialog grows with it) and fades the body in. Put on the <summary>'s onClick.
export function easeDetails(e: MouseEvent<HTMLElement>) {
  const sum = e.currentTarget;
  const d = sum.parentElement as HTMLDetailsElement | null;
  if (!d || reduceMotion() || !d.animate) return; // native toggle
  e.preventDefault();
  const opening = !d.open;
  const chev = sum.querySelector<HTMLElement>(".material-symbols-outlined");
  const from = d.offsetHeight;
  d.getAnimations().forEach((a) => a.cancel());
  d.open = true;
  const to = opening ? d.offsetHeight : sum.offsetHeight + (d.offsetHeight - d.clientHeight);
  const ease = { duration: 260, easing: EASE };
  d.style.overflow = "hidden";
  if (chev) chev.style.transform = opening ? "rotate(90deg)" : "rotate(0deg)";
  const body = sum.nextElementSibling as HTMLElement | null;
  if (opening && body) body.animate({ opacity: [0, 1], transform: ["translateY(-4px)", "none"] }, { ...ease, duration: 220 });
  d.animate({ height: [`${from}px`, `${to}px`] }, ease).onfinish = () => {
    if (!opening) d.open = false;
    d.style.overflow = "";
    if (chev) chev.style.transform = "";
  };
}

export function Disclosure({ summary, open = false, children, plain = false }: { summary: ReactNode; open?: boolean; children: ReactNode; plain?: boolean }) {
  return (
    <details className={`rounded-[10px] ${plain ? "bg-surface-2" : "border border-border-subtle"}`} open={open}>
      <summary onClick={easeDetails} className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-text-muted hover:text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 rounded-[10px]">
        <span className="material-symbols-outlined text-[16px] transition-transform [details[open]>summary>&]:rotate-90" aria-hidden="true">chevron_right</span>
        {summary}
      </summary>
      {children}
    </details>
  );
}

// ---- Live request list -----------------------------------------------------------

export interface LiveStep {
  n: number;
  text: string;
  state: "run" | "done";
  ok?: boolean;
  warn?: boolean;
  note: string;
  status?: number;
  kind?: Classification;
  hint?: string;
  startedAt: number;
}

// "GET /models (no auth)" with the path as sent ("/v1/models").
export function stepText(label: string, method: string, path: string): string {
  if (/^Check model \(made-up id/.test(label)) return `${method} ${path}, made-up model id`;
  if (/^Control \(made-up path/.test(label)) return `${method} ${path} (control: a path no API has)`;
  const m = /^(GET|POST) \/\S*(.*)$/.exec(label);
  return m ? `${method} ${path}${m[2]}` : label;
}

// What a response means, in the mockup's "400 · path + key OK" form.
export function stepNote(label: string, status: number, kind: Classification, hint = "", retrying = false): { note: string; ok: boolean; warn: boolean } {
  const badKey = /^Bad-key check/.test(label);
  const canary = /made-up id/.test(label);
  const control = /^Control/.test(label);
  const list = /^GET .*models/.test(label);
  const s = status ? String(status) : "";
  const say = (t: string) => (s && t ? `${s} · ${t}` : s || t);
  if (retrying) return { note: say("Too Many Requests · retrying"), ok: false, warn: true };
  if (kind === "network") return { note: hint || "no answer", ok: false, warn: true };
  if (badKey) return kind === "auth" ? { note: say("key is really checked"), ok: true, warn: false } : { note: say("a wrong key got in too"), ok: false, warn: true };
  if (control) return { note: say(kind === "missing" ? "not found, as it should be" : "same answer as a real path"), ok: kind === "missing", warn: kind !== "missing" };
  if (canary) {
    if (kind === "unknown-model" || kind === "model-denied") return { note: say("unknown model, so guessing works"), ok: true, warn: false };
    if (/max_completion_tokens/i.test(hint)) return { note: say("wants max_completion_tokens"), ok: false, warn: false };
    return { note: say(hint || "doesn't check model names"), ok: false, warn: false };
  }
  switch (kind) {
    case "ok": return { note: say(list ? "model list" : "OK"), ok: true, warn: false };
    case "accepted": return { note: say(/max_completion_tokens/i.test(hint) ? "wants max_completion_tokens" : "path + key OK"), ok: true, warn: false };
    case "unknown-model": case "model-denied": return { note: say("path + key OK"), ok: true, warn: false };
    case "generated": return { note: say("it generated a reply to an empty request"), ok: true, warn: true };
    case "rate": return { note: say("Too Many Requests"), ok: false, warn: true };
    case "server": return { note: say(hint || "server error"), ok: false, warn: true };
    case "html": return { note: say(hint || "HTML page, not an API"), ok: false, warn: false };
    case "auth": return { note: say(hint || "unauthorized"), ok: false, warn: false };
    case "gated": return { note: say(hint || "unauthorized client"), ok: false, warn: false };
    case "missing": return { note: s || "not found", ok: false, warn: false };
    default: return { note: say(hint), ok: false, warn: false };
  }
}

export function StepList({ steps, now }: { steps: LiveStep[]; now: number }) {
  if (!steps.length) return null;
  return (
    <ul className="flex flex-col gap-1.5 rounded-[10px] bg-surface-2 p-3">
      {steps.map((s) => {
        const secs = s.state === "run" ? Math.floor((now - s.startedAt) / 1000) : 0;
        const icon = s.state === "run" ? <Spinner />
          : s.ok ? <span className="material-symbols-outlined ep-pop text-[16px] text-green-500" aria-hidden="true">check_circle</span>
          : s.warn ? <span className="material-symbols-outlined ep-pop text-[16px] text-yellow-600 dark:text-yellow-400" aria-hidden="true">error</span>
          : <span className="material-symbols-outlined ep-pop text-[16px] text-text-subtle" aria-hidden="true">cancel</span>;
        return (
          <li key={`${s.n}-${s.state}`} className={`flex items-start gap-2 text-xs ${s.state === "run" ? "ep-in" : ""}`}>
            {icon}
            <span className={`min-w-0 ${s.ok ? "text-text-main" : "text-text-muted"}`}>{s.text}</span>
            <span className="ml-auto shrink-0 pl-2 text-right font-mono text-[11px] text-text-subtle">{s.state === "run" ? (secs >= 2 ? `${secs}s…` : "") : s.note}</span>
          </li>
        );
      })}
    </ul>
  );
}

// "How we tested it": the live list, then every raw response (key redacted).
export function TestedBox({ steps, raw, count, open, now }: { steps: LiveStep[]; raw: DetectStep[]; count: number; open: boolean; now: number }) {
  return (
    <Disclosure open={open} summary={<>How we tested it <span className="text-text-subtle">· {count} free request{count === 1 ? "" : "s"}</span></>}>
      <div className="flex flex-col gap-2 px-3 pb-3">
        <StepList steps={steps} now={now} />
        {raw.length > 0 && (
          <Disclosure plain summary={<>Raw responses <span className="text-text-subtle">· {raw.length}</span></>}>
            <ul className="flex max-h-60 flex-col gap-1.5 overflow-y-auto px-3 pb-3">
              {raw.map((s, i) => (
                <li key={i} className="flex min-w-0 flex-col gap-0.5 text-xs">
                  <div className="flex items-center gap-2">
                    <span className={`w-8 shrink-0 font-mono ${s.status >= 200 && s.status < 300 ? "text-green-600 dark:text-green-400" : "text-text-subtle"}`}>{s.status || "ERR"}</span>
                    <span className="min-w-0 truncate text-text-main" title={`${s.method} ${s.url}`}>{s.label}</span>
                  </div>
                  {s.preview && <span className="ml-10 truncate font-mono text-[11px] text-text-subtle" title={s.preview}>{s.preview}</span>}
                </li>
              ))}
            </ul>
          </Disclosure>
        )}
      </div>
    </Disclosure>
  );
}

// ---- The drawn "It works" check ---------------------------------------------------

export const DrawnCheck = () => (
  <svg className="ep-check size-5 shrink-0 text-green-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle className="ep-check-ring" cx="12" cy="12" r="9.5" />
    <path className="ep-check-tick" d="M7.5 12.5l3 3 6-6.5" />
  </svg>
);

// ---- Site icon tile ---------------------------------------------------------------
// iOS home-screen style: the site's own icon filling a continuous-corner tile,
// else a letter on a colour picked from the name.
const TILE_BG = ["#0ea5e9", "#8b5cf6", "#f43f5e", "#f59e0b", "#10b981", "#64748b"];
export function AppIcon({ icon, name, size = 24 }: { icon?: string | null; name: string; size?: number }) {
  const r = Math.round(size * 0.225);
  const style = { width: size, height: size, borderRadius: r, boxShadow: "0 1px 2px rgb(0 0 0 / .12), 0 2px 6px rgb(0 0 0 / .06)" };
  if (icon) {
    // A data: URL copied server-side; never hotlinked.
    // eslint-disable-next-line @next/next/no-img-element
    return <span className="relative inline-flex shrink-0 overflow-hidden" style={style}><img alt="" src={icon} className="block size-full object-cover" /></span>;
  }
  const n = (name || "?").trim() || "?";
  const bg = TILE_BG[[...n].reduce((a, c) => a + c.charCodeAt(0), 0) % TILE_BG.length];
  return (
    <span className="relative inline-flex shrink-0 overflow-hidden" style={style}>
      <span className="flex size-full items-center justify-center font-semibold text-white" style={{ background: `linear-gradient(160deg,${bg}cc,${bg})`, fontSize: Math.round(size * 0.42) }}>{n[0].toUpperCase()}</span>
    </span>
  );
}

// ---- Models by maker --------------------------------------------------------------

// Model maker from the id (Snowflake prefixes some, e.g. "openai-gpt-6-sol").
const MAKERS: [RegExp, string, string][] = [
  [/claude/i, "anthropic", "Anthropic"], [/gpt|^o\d|openai/i, "openai", "OpenAI"], [/gemini|gemma/i, "gemini", "Google"],
  [/deepseek/i, "deepseek", "DeepSeek"], [/kimi|moonshot/i, "kimi", "Moonshot"], [/glm/i, "glm", "Z.ai"], [/minimax/i, "minimax", "MiniMax"],
  [/mimo/i, "xiaomi-mimo", "Xiaomi"], [/mistral|mixtral|devstral|codestral|magistral|ministral/i, "mistral", "Mistral"], [/grok/i, "xai", "xAI"],
];
const MAKER_ORDER = ["Anthropic", "OpenAI", "Google", "xAI", "DeepSeek", "Moonshot", "Z.ai", "MiniMax", "Xiaomi", "Mistral", "Other"];
const makerOf = (id: string) => MAKERS.find(([re]) => re.test(id.split("/").pop() || id) || re.test(id));

// "claude-opus-4-6" -> "Claude Opus 4.6", "openai-gpt-6.1-sol" -> "GPT-6.1 Sol"
export function prettyModel(id: string): string {
  const bare = id.split("/").pop() || id;
  const words = bare.replace(/^openai-/, "").replace(/(\d)-(\d)(?=$|-)/g, "$1.$2").split("-");
  const BRANDS: Record<string, string> = { gpt: "GPT", glm: "GLM", deepseek: "DeepSeek", minimax: "MiniMax", mimo: "MiMo", qwen: "Qwen" };
  return words.map((w) => BRANDS[w.toLowerCase()] || (/^v\d/.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ").replace(/^GPT (\d)/, "GPT-$1");
}

export function ModelsByMaker({ ids }: { ids: string[] }) {
  const groups = new Map<string, { logo?: string; ids: string[] }>();
  for (const m of ids) {
    const mk = makerOf(m);
    const k = mk?.[2] || "Other";
    if (!groups.has(k)) groups.set(k, { logo: mk?.[1], ids: [] });
    groups.get(k)!.ids.push(m);
  }
  const sorted = [...groups].sort((a, b) => MAKER_ORDER.indexOf(a[0]) - MAKER_ORDER.indexOf(b[0]));
  return (
    <div className="ep-in flex max-h-48 flex-col gap-2 overflow-y-auto rounded-[8px] bg-surface-2 p-2">
      {sorted.map(([name, g]) => (
        <div key={name} className="flex flex-col gap-1">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold text-text-main">
            {g.logo
              // eslint-disable-next-line @next/next/no-img-element
              ? <img src={`/providers/${g.logo}.png`} alt="" className="size-4 shrink-0 rounded-[4px] bg-white object-contain p-[1px]" />
              : <span className="flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-surface text-[9px] font-semibold text-text-muted">{name[0]}</span>}
            {name}<span className="font-normal text-text-subtle">{g.ids.length}</span>
          </p>
          <div className="flex flex-wrap gap-1 pl-[22px]">
            {g.ids.map((m) => <span key={m} title={m} className="rounded-full border border-border-subtle bg-surface px-2 py-0.5 text-[11px] text-text-muted">{prettyModel(m)}</span>)}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---- Two for one ------------------------------------------------------------------

export interface PathSplit {
  primary: Protocol;
  used: Protocol[];                          // primary first
  sent: Partial<Record<Protocol, string[]>>; // where each model is sent
  served: Partial<Record<Protocol, string[]>>;
  total: number;
}

// Each model goes to one API (see buildRoutes); null unless two APIs serve models.
export function splitPaths(models: string[], primary: Protocol, routes: Record<string, Protocol> | undefined, byProtocol: Partial<Record<Protocol, string[]>> | null | undefined): PathSplit | null {
  const served = byProtocol || {};
  const used = (Object.keys(served) as Protocol[]).filter((p) => served[p]?.length);
  if (used.length < 2) return null;
  const sent: Partial<Record<Protocol, string[]>> = {};
  for (const m of models) { const p = routes?.[m] || primary; (sent[p] ||= []).push(m); }
  // The mockup's order: the OpenAI path first, Anthropic Messages second.
  const order = [...used].sort((a, b) => (a === "anthropic" ? 1 : 0) - (b === "anthropic" ? 1 : 0)).filter((p) => sent[p]?.length);
  if (order.length < 2) return null;
  return { primary, used: order, sent, served, total: models.length };
}

interface TwoPathsProps {
  split: PathSplit;
  open: Protocol | null;
  onOpen: (p: Protocol | null) => void;
  checks?: Partial<Record<Protocol, ModelCheck>>;
  notUsed: string[];
}
export function TwoPaths({ split, open, onOpen, checks, notUsed }: TwoPathsProps) {
  const { used, sent, served, primary, total } = split;
  const note = (p: Protocol) => {
    const n = sent[p]?.length || 0;
    if (p === "anthropic") {
      const extra = (sent[p] || []).filter((m) => !/claude/i.test(m)).length;
      return extra ? `Claude, plus ${extra} only Messages has` : "Claude models";
    }
    if (p === primary || used.includes("anthropic")) return `${p === primary ? "Main API · " : ""}everything else (${served[p]?.length || 0} answer here)`;
    return `${n} only ${SHORT[p]} has`;
  };
  const asked = used.map((p) => checks?.[p]?.total || 0);
  const sameAsked = asked.every((n) => n === asked[0]) && asked[0] > 0;
  const freeChecks = used.reduce((a, p) => a + (checks?.[p]?.checked || 0), 0);
  const servedSum = used.reduce((a, p) => a + (served[p]?.length || 0), 0);
  // The mockup's wording: "Messages served 13, Chat 35" (Messages first, "served" once).
  const servedText = [...used].sort((a, b) => (a === "anthropic" ? 0 : 1) - (b === "anthropic" ? 0 : 1)).map((p, i) => `${SHORT[p]}${i ? "" : " served"} ${served[p]?.length || 0}`).join(", ");
  return (
    <div className="ep-in flex items-start gap-2 rounded-[8px] border border-border-subtle bg-surface px-3 py-2.5 text-xs">
      <span className="material-symbols-outlined text-[16px] text-brand-500" aria-hidden="true">call_split</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="font-medium text-text-main">Two for one: both APIs work</span>
        <div className="grid grid-cols-2 gap-2">
          {used.map((p) => (
            <button
              key={p}
              type="button"
              aria-expanded={open === p}
              onClick={() => onOpen(open === p ? null : p)}
              className={`rounded-[8px] px-2.5 py-1.5 text-left transition-colors ${open === p ? "bg-brand-500/10 ring-1 ring-brand-500/40" : "bg-surface-2 hover:bg-surface-3"}`}
            >
              <span className="flex items-center justify-between gap-2 text-[11px] text-text-muted">{PROTOCOL_NAME[p]}<span className={`material-symbols-outlined text-[14px] transition-transform ${open === p ? "rotate-180" : ""}`} aria-hidden="true">expand_more</span></span>
              <span className="block font-semibold text-text-main">{sent[p]?.length || 0} models</span>
              <span className="block text-[11px] text-text-subtle">{note(p)}</span>
            </button>
          ))}
        </div>
        {open && sent[open] && <ModelsByMaker key={open} ids={sent[open]!} />}
        <span className="text-text-muted">
          {used.map((p) => sent[p]?.length || 0).join(" + ")} = {total} models.
          {sameAsked ? ` We asked about the same ${asked[0]} ids on each API (${freeChecks} free checks, nothing generated): ` : " "}
          {servedText}, and {servedSum - total} answer on both.
          {notUsed.length ? ` Not used: ${notUsed.join(", ")}.` : ""}
        </span>
      </div>
    </div>
  );
}

// ---- Failure copy -----------------------------------------------------------------

export type FailKind = "key" | "revoked" | "unreachable" | "down" | "other";
export interface FailCopy { kind: FailKind; icon: string; title: string; body: string }

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const NUM_WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
const countWord = (n: number) => NUM_WORDS[n] ?? String(n);

export function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

interface FailInput {
  failure?: string;
  error?: string;
  steps: LiveStep[];
  url: string;
  revoked?: { checked: number } | null;
  // Requests that got no answer per the server's own step list; the live list can lag a tick behind it.
  netCount?: number;
}
export function failCopy({ failure, error, steps, url, revoked, netCount = 0 }: FailInput): FailCopy {
  const done = steps.filter((s) => s.state === "done");
  if (revoked) {
    return {
      kind: "revoked", icon: "key_off", title: "Your key stopped working",
      body: `${revoked.checked ? `It worked for the first ${revoked.checked} checks, then every request came back 401.` : "It passed the first requests, then every model check came back 401."} The key was probably revoked or rotated just now. That says nothing about which models exist, so we haven't marked any as missing. Paste a fresh key and connect again.`,
    };
  }
  if (failure === "key") {
    const auth = done.filter((s) => s.kind === "auth");
    const last = auth[auth.length - 1];
    const every = auth.length && auth.length === done.filter((s) => s.status).length;
    const what = last ? `${last.status}${last.hint ? ` ${last.hint}` : ""}` : "401";
    return {
      kind: "key", icon: "key_off", title: "The key was rejected",
      body: `${every ? "Every request" : "The requests that used the key"} came back ${what}, so we never got far enough to see the API type or models. Check the key (no spaces, not expired, right account) and try again.`,
    };
  }
  if (failure === "unreachable") {
    const net = done.filter((s) => s.kind === "network");
    const hint = net[net.length - 1]?.hint || "no answer";
    const n = Math.max(net.length, netCount) || 1;
    const host = hostOf(url);
    const why = /refused/.test(hint) ? `${countWord(n)} ${n === 1 ? "request" : "requests"}, each refused at the door, so nothing is listening on that port.`
      : /not found/.test(hint) ? `The name ${host.replace(/:\d+$/, "")} doesn't resolve, so there's no server to ask. Check the spelling.`
      : `${countWord(n)} ${n === 1 ? "request" : "requests"}, ${hint === "no answer" ? "no answer" : hint} each, so we stopped instead of waiting on the rest.`;
    return {
      kind: "unreachable", icon: "wifi_off", title: `Couldn't reach ${host}`,
      body: `${why} The host may be behind a VPN or firewall, or the port is wrong. Nothing about the key was checked.`,
    };
  }
  if (failure === "down") {
    const fives = done.filter((s) => (s.status || 0) >= 500);
    const top = fives[fives.length - 1];
    const what = top ? `${top.status}${top.hint ? ` ${top.hint}` : ""}` : "5xx";
    const every = fives.length && fives.length === done.filter((s) => s.status).length;
    return {
      kind: "down", icon: "cloud_off", title: "The server is down",
      body: `It answered ${every ? "every request" : plural(fives.length, "request")} with ${what}, so it's down or overloaded right now. That isn't a problem with your URL or key, but we can't check either until it's back. Try again in a bit.`,
    };
  }
  const titles: Record<string, string> = {
    gated: "It only lets in specific clients",
    rate: "It's rate limiting us",
    html: "That's a web page, not an API",
    "catch-all": "Every path answers the same",
    "no-api": "No OpenAI or Anthropic API here",
    timeout: "Ran out of time",
  };
  return { kind: "other", icon: failure === "rate" ? "timer" : "error", title: titles[failure || ""] || "Couldn't connect", body: error || "We couldn't work out this endpoint." };
}

// Why model checks stopped early, for the "Stopped early" box.
export const STOP_WHY: Record<StopReason, string> = {
  rate: "The endpoint kept answering 429 Too Many Requests, even one at a time after waiting.",
  auth: "The key was refused part-way through.",
  denied: "The key isn't allowed to use any of the models checked.",
  generated: "It ran a model on an empty request, so we stopped asking to avoid charges.",
  failing: "It kept failing (network errors, timeouts or 5xx).",
  deadline: "Detection ran out of time.",
  aborted: "Detection was cancelled.",
};
