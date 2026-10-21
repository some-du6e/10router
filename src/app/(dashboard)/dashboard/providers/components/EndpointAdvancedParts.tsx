"use client";

// Building blocks shared by the add dialog's Advanced panel (EndpointAdvanced)
// and the endpoint page's Advanced section (EndpointAdvancedStudio). Class
// strings follow mockups/provider-setup/src/app.js (advanced(), ultra(),
// mimicRow(), requestStudio()).
import { useId } from "react";
import type { ReactNode } from "react";
import { MIMICS, MIMIC_LABELS, MIMIC_HEADERS, mimicHeaderText } from "@/shared/utils/nodeQuirks.js";
import type { AuthHeader, Mimic, NodeQuirks, RawOverrides, RouteProtocol, StreamMode } from "@/shared/utils/nodeQuirks.js";
import { buildSampleRequest, DEFAULT_PATHS } from "@/shared/utils/endpointOverrides.js";

export type ProtoChoice = "auto" | RouteProtocol;
export const PROTO_OPTS: [ProtoChoice, string][] = [["auto", "Auto"], ["openai-chat", "OpenAI Chat"], ["openai-responses", "Responses"], ["anthropic", "Anthropic"]];
export const PROTOCOL_LABELS: Record<RouteProtocol, string> = {
  "openai-chat": "OpenAI · Chat Completions",
  "openai-responses": "OpenAI · Responses",
  anthropic: "Anthropic · Messages",
};
export const AUTH_OPTS: [AuthHeader, string][] = [["bearer", "Bearer"], ["x-api-key", "x-api-key"], ["api-key", "api-key"], ["both", "Both"]];
export const STREAM_OPTS: [StreamMode, string][] = [["auto", "As requested"], ["always", "Always"], ["never", "Never"]];
export const mimicLabel = (m: Mimic | undefined) => MIMIC_LABELS[m || "none"];

// The key goes the protocol's way unless the user picked one.
export function effectiveAuth(q: NodeQuirks, protocol: RouteProtocol): AuthHeader {
  return q.authHeader || (protocol === "anthropic" ? "both" : q.apiKeyHeader === "api-key" ? "api-key" : "bearer");
}

// Password managers treat these as login fields without this.
export const NO_PM = { autoComplete: "off", spellCheck: false, "data-1p-ignore": true, "data-lpignore": "true", "data-bwignore": true, "data-form-type": "other" } as const;
const RAW_CTL = "w-full rounded-[8px] border border-border bg-surface-2 px-2.5 py-1.5 font-mono text-xs text-text-main placeholder-text-muted/60 focus:outline-none focus:ring-2 focus:ring-brand-500/30";
const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/30";

export const Code = ({ children }: { children: ReactNode }) => <code className="font-mono">{children}</code>;

// The mockup's switch: w-9 h-5 with a size-4 thumb.
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-brand-500/30 disabled:cursor-not-allowed disabled:opacity-50 ${checked ? "bg-brand-500" : "bg-surface-3"}`}
    >
      <span className={`pointer-events-none mt-0.5 inline-block size-4 transform rounded-full bg-white shadow-sm transition duration-200 ease-in-out ${checked ? "translate-x-4" : "translate-x-0.5"}`} />
    </button>
  );
}

// Segmented control. `size` "sm" is the h-6 / 11px row, "md" the h-7 / xs one.
export function Seg<T extends string>({ options, value, onChange, label, size = "sm", wrap = false, disabled }: { options: [T, string][]; value: T; onChange: (v: T) => void; label: string; size?: "sm" | "md"; wrap?: boolean; disabled?: (v: T) => string | null }) {
  const h = size === "sm" ? "h-6 text-[11px]" : "h-7 text-xs";
  return (
    <div role="radiogroup" aria-label={label} className={`inline-flex ${wrap ? "max-w-full flex-wrap" : "w-max"} items-center rounded-[10px] bg-surface-2 p-1`}>
      {options.map(([v, l]) => {
        const why = disabled?.(v) || null;
        return (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={value === v}
            disabled={!!why}
            title={why || undefined}
            onClick={() => onChange(v)}
            className={`inline-flex shrink-0 items-center justify-center rounded-[8px] px-2.5 font-medium ${h} ${FOCUS} disabled:cursor-not-allowed disabled:opacity-50 ${value === v ? "bg-surface text-text-main shadow-sm" : "text-text-muted hover:text-text-main"}`}
          >
            {l}
          </button>
        );
      })}
    </div>
  );
}

export function SwitchRow({ title, desc, checked, onChange, tag, label, className = "py-2" }: { title: ReactNode; desc: ReactNode; checked: boolean; onChange: (v: boolean) => void; tag?: string; label?: string; className?: string }) {
  return (
    <div className={`flex items-center justify-between gap-4 ${className}`}>
      <div className="min-w-0">
        <p className="text-sm font-medium text-text-main">{title}{tag && <span className="ml-1 text-xs font-normal text-text-subtle">· {tag}</span>}</p>
        <p className="text-xs text-text-muted">{desc}</p>
      </div>
      <Switch checked={checked} onChange={onChange} label={label || (typeof title === "string" ? title : "")} />
    </div>
  );
}

export function SmallButton({ icon, children, onClick, variant = "secondary" }: { icon?: string; children: ReactNode; onClick: () => void; variant?: "secondary" | "ghost" }) {
  const v = variant === "secondary" ? "bg-surface-2 hover:bg-surface-3 text-text-main border border-border" : "text-text-muted hover:bg-surface-2 hover:text-text-main";
  return (
    <button type="button" onClick={onClick} className={`inline-flex h-7 cursor-pointer items-center justify-center gap-2 rounded-[8px] px-3 text-xs font-semibold transition-all duration-150 ease-out active:scale-[0.97] ${v} ${FOCUS}`}>
      {icon && <span aria-hidden="true" className="material-symbols-outlined text-[18px]">{icon}</span>}
      {children}
    </button>
  );
}

// ---- Raw override fields ----

type RawKey = Exclude<keyof RawOverrides, "stream">;
export function RawField({ id, label, hint, children }: { id: string; label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-text-main">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-text-muted">{hint}</p>}
    </div>
  );
}
export function RawInput({ id, raw, k, placeholder, onChange, onBlur, inputMode }: { id: string; raw: RawOverrides; k: RawKey; placeholder: string; onChange: (k: RawKey, v: string) => void; onBlur?: () => void; inputMode?: "numeric" | "url" }) {
  return <input id={id} {...NO_PM} inputMode={inputMode} value={raw[k] ?? ""} placeholder={placeholder} onChange={(e) => onChange(k, e.target.value)} onBlur={onBlur} className={RAW_CTL} />;
}
export function RawArea({ id, raw, k, placeholder, rows = 3, onChange, onBlur, invalid }: { id: string; raw: RawOverrides; k: RawKey; placeholder: string; rows?: number; onChange: (k: RawKey, v: string) => void; onBlur?: () => void; invalid?: boolean }) {
  return <textarea id={id} {...NO_PM} rows={rows} aria-invalid={invalid || undefined} value={raw[k] ?? ""} placeholder={placeholder} onChange={(e) => onChange(k, e.target.value)} onBlur={onBlur} className={`${RAW_CTL} resize-y`} />;
}

// Placeholders that match the endpoint ("model-id => vendor/model-id").
export function rawPlaceholders(protocol: RouteProtocol, model?: string) {
  const m = model || "model-id";
  return {
    path: DEFAULT_PATHS[protocol],
    query: "api-version=2024-10-21",
    headers: "x-org-id: acme\n-user-agent",
    body: '{ "temperature": 0.2, "metadata": { "team": "infra" } }',
    bodyShort: '{ "temperature": 0.2 }',
    drop: "stream_options, parallel_tool_calls",
    models: `${m} => vendor/${m}`,
    timeout: "600",
    retries: "2",
    proxy: "socks5://127.0.0.1:1080",
  };
}

// ---- Client identity ----

// Legit APIs never need this, so picking one always shows it.
export function RedFlag({ who }: { who: string }) {
  return (
    <div role="alert" className="flex gap-2 rounded-[10px] border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-text-main">
      <span aria-hidden="true" className="material-symbols-outlined shrink-0 text-[16px] text-yellow-600 dark:text-yellow-400">warning</span>
      <div className="flex flex-col gap-1">
        <p className="font-medium">It can inject tool calls into your agent.</p>
        <p className="text-text-muted">An endpoint that only lets {who} in is a middleman, not a real API. It sees every prompt and can rewrite the replies, including adding tool calls your agent will run: shell commands, file edits, fetches. Keep tool approvals on, never send it secrets, and only use it if you trust whoever runs it. It&apos;s often a resold subscription too, so expect sudden bans.</p>
      </div>
    </div>
  );
}

export function MimicRow({ quirks, onChange, className = "py-2" }: { quirks: NodeQuirks; onChange: (patch: Pick<NodeQuirks, "mimic" | "customHeaders">) => void; className?: string }) {
  const id = useId();
  const m = quirks.mimic || "none";
  const opts = MIMICS.map((v) => [v, v === "codex" ? "Codex CLI" : MIMIC_LABELS[v]] as [Mimic, string]);
  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p id={`${id}-l`} className="text-sm font-medium text-text-main">Pretend to be a client</p>
          <p className="text-xs text-text-muted">Send the headers a specific tool sends.</p>
        </div>
        <Seg label="Pretend to be a client" options={opts} value={m} onChange={(v) => onChange({ mimic: v })} wrap />
      </div>
      {m !== "none" && (
        <div className="ep-in flex flex-col gap-2">
          <label htmlFor={`${id}-h`} className="sr-only">{m === "custom" ? "Custom identity headers" : `${mimicLabel(m)} headers`}</label>
          <textarea
            id={`${id}-h`}
            {...NO_PM}
            rows={3}
            readOnly={m !== "custom"}
            placeholder={m === "custom" ? "header-name: value" : undefined}
            value={m === "custom" ? quirks.customHeaders ?? "" : MIMIC_HEADERS[m]}
            onChange={(e) => onChange({ customHeaders: e.target.value })}
            className="w-full rounded-[10px] border border-border bg-surface-2 px-3 py-2 font-mono text-xs text-text-main focus:outline-none focus:ring-2 focus:ring-brand-500/30"
          />
          <RedFlag who={m === "custom" ? "a specific tool" : mimicLabel(m)} />
        </div>
      )}
    </div>
  );
}

// ---- "What gets sent" ----

export function RequestPreview({ baseUrl, protocol, model, apiKey, keyPlaceholder, quirks, className }: { baseUrl: string; protocol: RouteProtocol; model?: string; apiKey?: string; keyPlaceholder?: string; quirks: NodeQuirks; className: string }) {
  const r = buildSampleRequest({ baseUrl, protocol, model, apiKey, keyPlaceholder, quirks });
  const hl = (t: string) => <span className="text-brand-600 dark:text-brand-300">{t}</span>;
  return (
    <pre aria-live="polite" className={className}>
      {hl("POST")} {r.url}
      {"\n"}
      {r.headers.map(([k, v]) => <span key={k}>{hl(k)}: {v}{"\n"}</span>)}
      {"\n"}
      {JSON.stringify(r.body, null, 2)}
      {r.jsonError && <>{"\n\n"}<span className="text-red-600 dark:text-red-400">Body override isn&apos;t valid JSON ({r.jsonError}), so it&apos;s ignored.</span></>}
    </pre>
  );
}

// True when anything in Ultra advanced differs from the defaults.
export const ultraChanged = (q: NodeQuirks) =>
  Object.entries(q.overrides || {}).some(([, v]) => v && v !== "auto") || !!q.blockForeignTools || !!q.stripReasoning;

// Mimic header text is part of the identity shown in the preview too.
export { mimicHeaderText };
