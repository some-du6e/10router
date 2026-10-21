"use client";

// Advanced (+ nested Ultra advanced) for the add-endpoint dialog. Matches
// advanced() / ultra() in mockups/provider-setup/src/app.js. Controlled: the
// dialog owns `quirks` and `protoOverride` and sends quirks as-is on save
// (POST /api/provider-nodes sanitizes them, so invalid JSON is never stored).
import { useId } from "react";
import type { NodeQuirks, RawOverrides, RouteProtocol } from "@/shared/utils/nodeQuirks.js";
import {
  AUTH_OPTS, Code, MimicRow, PROTO_OPTS, PROTOCOL_LABELS, RawArea, RawField, RawInput, RequestPreview, Seg, SmallButton,
  STREAM_OPTS, Switch, SwitchRow, effectiveAuth, rawPlaceholders, ultraChanged,
} from "./EndpointAdvancedParts";
import type { ProtoChoice } from "./EndpointAdvancedParts";

export interface EndpointAdvancedProps {
  quirks: NodeQuirks;
  onChange: (patch: Partial<NodeQuirks>) => void;
  // API type: "auto" keeps the detected one.
  protoOverride: ProtoChoice;
  onProtoChange: (p: ProtoChoice) => void;
  // What detection found (null before it ran or when it failed).
  detected: RouteProtocol | null;
  // Every API that answered (two-path endpoints have two).
  protocols?: RouteProtocol[];
  // Two-path: Claude models routed to Messages.
  routed?: boolean;
  // Detection saw the endpoint reject max_tokens on Chat Completions.
  maxTokensRejected?: boolean;
  // For the "What gets sent" preview.
  baseUrl: string;
  model?: string;
  apiKey?: string;
  // Open on mount (the dialog opens it when detection failed).
  defaultOpen?: boolean;
}

export default function EndpointAdvanced({ quirks, onChange, protoOverride, onProtoChange, detected, protocols, routed, maxTokensRejected, baseUrl, model, apiKey, defaultOpen = false }: EndpointAdvancedProps) {
  const id = useId();
  const proto: RouteProtocol = protoOverride !== "auto" ? protoOverride : detected || "openai-chat";
  const paths = new Set<RouteProtocol>([...(protocols?.length ? protocols : detected ? [detected] : []), proto]);
  const showBeta = paths.has("anthropic");
  const showMaxTokens = paths.has("openai-chat");
  const auth = effectiveAuth(quirks, proto);
  const mctReason = quirks.maxCompletionTokens && maxTokensRejected
    ? <>On because it rejected <Code>max_tokens</Code> on Chat Completions.</>
    : quirks.maxCompletionTokens && auth === "api-key"
      ? <>On: Azure&apos;s newer models only accept <Code>max_completion_tokens</Code>.</>
      : <>Rename <Code>max_tokens</Code> for endpoints that reject it.</>;

  return (
    <details className="group rounded-[10px] border border-border-subtle" open={defaultOpen || undefined}>
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-[10px] px-3 py-2 text-xs text-text-muted hover:text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/30">
        <span aria-hidden="true" className="material-symbols-outlined text-[16px] transition-transform group-open:rotate-90">chevron_right</span>
        Advanced <span className="text-text-subtle">· if something&apos;s off</span>
      </summary>
      <div className="flex flex-col divide-y divide-border-subtle px-3 pb-2">
        <div className="flex items-center justify-between gap-4 py-2">
          <div>
            <p className="text-sm font-medium text-text-main">API type</p>
            {detected && <p className="text-xs text-text-muted">Detected: {PROTOCOL_LABELS[detected]}{routed ? ", Claude routed to Messages" : ""}</p>}
          </div>
          <Seg label="API type" options={PROTO_OPTS} value={protoOverride} onChange={onProtoChange} wrap />
        </div>
        {showBeta && (
          <SwitchRow
            title="Strip all beta flags"
            desc={<>Off: we drop only the flags it rejects. On: send no beta flags at all. Claude Code&apos;s <Code>CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS</Code> can&apos;t do either; it still sends <Code>oauth-2025-04-20</Code>.</>}
            checked={!!quirks.stripBeta}
            onChange={(v) => onChange({ stripBeta: v })}
          />
        )}
        {showMaxTokens && (
          <SwitchRow
            title={<>Send <Code>max_completion_tokens</Code></>} label="Send max_completion_tokens"
            desc={mctReason}
            checked={!!quirks.maxCompletionTokens}
            onChange={(v) => onChange({ maxCompletionTokens: v })}
          />
        )}
        <div className="flex items-center justify-between gap-4 py-2">
          <div>
            <p className="text-sm font-medium text-text-main">Auth header</p>
            <p className="text-xs text-text-muted">How the key is sent upstream.</p>
          </div>
          <Seg label="Auth header" size="md" wrap options={AUTH_OPTS} value={auth} onChange={(v) => onChange({ authHeader: v })} />
        </div>
        <MimicRow quirks={quirks} onChange={onChange} />
        <div className="py-2">
          <UltraAdvanced id={id} quirks={quirks} onChange={onChange} protocol={proto} baseUrl={baseUrl} model={model} apiKey={apiKey} />
        </div>
      </div>
    </details>
  );
}

// Nested, collapsed by default. Applied after everything above.
function UltraAdvanced({ id, quirks, onChange, protocol, baseUrl, model, apiKey }: { id: string; quirks: NodeQuirks; onChange: (patch: Partial<NodeQuirks>) => void; protocol: RouteProtocol; baseUrl: string; model?: string; apiKey?: string }) {
  const raw = quirks.overrides || {};
  const ph = rawPlaceholders(protocol, model);
  const set = (k: keyof RawOverrides, v: string) => onChange({ overrides: { ...raw, [k]: v } });
  const f = (k: string) => `${id}-raw-${k}`;
  const group = (title: string, inner: React.ReactNode) => (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-text-subtle">{title}</p>
      {inner}
    </div>
  );
  return (
    <details className="group/ultra rounded-[10px] border border-dashed border-border">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-[10px] px-3 py-2 text-xs text-text-muted hover:text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/30">
        <span aria-hidden="true" className="material-symbols-outlined text-[16px] transition-transform group-open/ultra:rotate-90">chevron_right</span>
        <span aria-hidden="true" className="material-symbols-outlined text-[16px]">tune</span>
        Ultra advanced <span className="text-text-subtle">· override any part of the request</span>
        {ultraChanged(quirks) && <span className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-brand-500/10 px-2 py-0.5 text-[10px] font-semibold text-brand-600 dark:text-brand-300">custom</span>}
      </summary>
      <div className="flex flex-col gap-5 px-3 pb-3 pt-1">
        <p className="text-[11px] text-text-muted">Applied after everything above, on every request to this endpoint. Leave a field empty to keep what 10router would send.</p>
        {group("URL", (
          <div className="grid gap-3 sm:grid-cols-2">
            <RawField id={f("path")} label="Path" hint="Replaces the detected path."><RawInput id={f("path")} raw={raw} k="path" placeholder={ph.path} onChange={set} /></RawField>
            <RawField id={f("query")} label="Query string" hint="Added to every request."><RawInput id={f("query")} raw={raw} k="query" placeholder={ph.query} onChange={set} /></RawField>
          </div>
        ))}
        {group("Headers", (
          <RawField id={f("headers")} label="Extra headers" hint={<>One per line. <Code>name: value</Code> sets, <Code>-name</Code> removes.</>}>
            <RawArea id={f("headers")} raw={raw} k="headers" placeholder={ph.headers} onChange={set} />
          </RawField>
        ))}
        {group("Body", (
          <>
            <RawField id={f("body")} label="Merge into body (JSON)" hint={<>Deep-merged into every request. <Code>null</Code> deletes a field.</>}>
              <RawArea id={f("body")} raw={raw} k="body" rows={4} placeholder={ph.body} onChange={set} />
            </RawField>
            <RawField id={f("drop")} label="Drop fields" hint="Removed before sending. Comma or space separated."><RawInput id={f("drop")} raw={raw} k="drop" placeholder={ph.drop} onChange={set} /></RawField>
            <RawField id={f("models")} label="Rename models" hint={<>One per line, <Code>ours =&gt; theirs</Code>.</>}><RawArea id={f("models")} raw={raw} k="models" rows={2} placeholder={ph.models} onChange={set} /></RawField>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-medium text-text-main">Streaming</p>
              <Seg label="Streaming" options={STREAM_OPTS} value={raw.stream || "auto"} onChange={(v) => onChange({ overrides: { ...raw, stream: v } })} />
            </div>
          </>
        ))}
        {group("Connection", (
          <>
            <div className="grid grid-cols-2 gap-3">
              <RawField id={f("timeout")} label="Timeout (s)"><RawInput id={f("timeout")} raw={raw} k="timeout" inputMode="numeric" placeholder={ph.timeout} onChange={set} /></RawField>
              <RawField id={f("retries")} label="Retries"><RawInput id={f("retries")} raw={raw} k="retries" inputMode="numeric" placeholder={ph.retries} onChange={set} /></RawField>
            </div>
            <RawField id={f("proxy")} label="Proxy" hint="HTTP or SOCKS URL for this endpoint only."><RawInput id={f("proxy")} raw={raw} k="proxy" inputMode="url" placeholder={ph.proxy} onChange={set} /></RawField>
          </>
        ))}
        {group("Response", (
          <>
            <div className="flex items-center justify-between gap-4">
              <div><p className="text-sm font-medium text-text-main">Block unexpected tool calls</p><p className="text-xs text-text-muted">Drop tool calls for tools your client never offered. Catches endpoints that inject their own.</p></div>
              <Switch label="Block unexpected tool calls" checked={!!quirks.blockForeignTools} onChange={(v) => onChange({ blockForeignTools: v })} />
            </div>
            <div className="flex items-center justify-between gap-4">
              <div><p className="text-sm font-medium text-text-main">Strip reasoning from replies</p><p className="text-xs text-text-muted">For clients that choke on thinking blocks.</p></div>
              <Switch label="Strip reasoning from replies" checked={!!quirks.stripReasoning} onChange={(v) => onChange({ stripReasoning: v })} />
            </div>
          </>
        ))}
        {group("What gets sent", (
          <>
            <RequestPreview baseUrl={baseUrl} protocol={protocol} model={model} apiKey={apiKey} quirks={quirks} className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-[10px] bg-surface-2 p-3 font-mono text-xs text-text-main" />
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] text-text-muted">A sample request with your overrides applied. The key is masked.</p>
              <SmallButton icon="restart_alt" onClick={() => onChange({ overrides: {}, blockForeignTools: false, stripReasoning: false })}>Reset</SmallButton>
            </div>
          </>
        ))}
      </div>
    </details>
  );
}
