"use client";

// Advanced on the endpoint page: the last card, collapsed, neutral. Blocks on
// the left, a sticky "What gets sent" on the right. Matches requestStudio() in
// mockups/provider-setup/src/app.js.
//
// Saves through `onSave(quirks, extra)` with only the changed keys (the node PUT
// merges them, so learned droppedBetas / modelRoutes survive). Switches save at
// once; text fields save 600ms after the last keystroke and on blur.
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { NodeQuirks, RawOverrides, RouteProtocol } from "@/shared/utils/nodeQuirks.js";
import { activeOverrides } from "@/shared/utils/endpointOverrides.js";
import {
  AUTH_OPTS, Code, MimicRow, PROTO_OPTS, PROTOCOL_LABELS, RawArea, RawField, RawInput, RequestPreview, Seg, SmallButton,
  STREAM_OPTS, SwitchRow, effectiveAuth, rawPlaceholders,
} from "./EndpointAdvancedParts";
import type { ProtoChoice } from "./EndpointAdvancedParts";

export interface StudioNode extends NodeQuirks {
  baseUrl?: string;
  type?: string;     // "openai-compatible" | "anthropic-compatible"
  apiType?: string;  // "chat" | "responses"
}
export interface StudioExtra {
  removeDroppedBetas?: string[];
  // Changing API type changes the node's type/apiType; the page decides how.
  protocol?: RouteProtocol;
}
export interface EndpointAdvancedStudioProps {
  node: StudioNode;
  onSave: (quirks: Partial<NodeQuirks>, extra?: StudioExtra) => unknown;
  // For the preview.
  model?: string;
  apiKey?: string;
  // The API type detection found when it was added, if known.
  detected?: RouteProtocol | null;
  // Changing API type: omit to hide the Protocol block's switch (read-only).
  canChangeProtocol?: boolean;
}

const nodeProtocol = (n: StudioNode): RouteProtocol =>
  n.type === "anthropic-compatible" ? "anthropic" : n.apiType === "responses" ? "openai-responses" : "openai-chat";
const DEBOUNCE_MS = 600;

export default function EndpointAdvancedStudio({ node, onSave, model, apiKey, detected, canChangeProtocol = false }: EndpointAdvancedStudioProps) {
  const id = useId();
  const proto = nodeProtocol(node);
  // Local draft so typing is instant; the server copy wins once it lands.
  const [draft, setDraft] = useState<NodeQuirks>(node);
  const [saving, setSaving] = useState(false);
  const pending = useRef<Partial<NodeQuirks>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { if (!timer.current) setDraft(node); }, [node]);

  const flush = async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const patch = pending.current;
    pending.current = {};
    if (!Object.keys(patch).length) return;
    setSaving(true);
    try { await onSave(patch); } finally { setSaving(false); }
  };
  useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); void flush(); } }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const change = (patch: Partial<NodeQuirks>, { debounce = false } = {}) => {
    setDraft((d) => ({ ...d, ...patch }));
    pending.current = { ...pending.current, ...patch };
    if (timer.current) clearTimeout(timer.current);
    if (debounce) timer.current = setTimeout(() => { timer.current = null; void flush(); }, DEBOUNCE_MS);
    else void flush();
  };
  const raw = draft.overrides || {};
  const setRaw = (k: keyof RawOverrides, v: string) => change({ overrides: { ...raw, [k]: v } }, { debounce: true });
  const ph = rawPlaceholders(proto, model);
  const f = (k: string) => `${id}-raw-${k}`;
  const routed = new Set(Object.values(draft.modelRoutes || {}));
  const showBeta = proto === "anthropic" || routed.has("anthropic");
  const showMax = proto === "openai-chat" || routed.has("openai-chat");
  const dropped = draft.droppedBetas || [];
  const mimicking = !!draft.mimic && draft.mimic !== "none";
  const active = activeOverrides(draft);

  return (
    <div className="rounded-[14px] border border-border-subtle bg-surface px-6 py-4 shadow-[var(--shadow-soft)]">
      <div id="advanced" className="scroll-mt-6" />
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-[8px] text-sm text-text-muted hover:text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/30">
          <span aria-hidden="true" className="material-symbols-outlined text-[18px] transition-transform group-open:rotate-90">chevron_right</span>
          <span className="font-medium">Advanced</span>
          <span className="text-text-subtle">· request settings</span>
          <span className="ml-auto text-xs text-text-subtle">{saving ? "Saving…" : active.length ? `${active.length} override${active.length === 1 ? "" : "s"}${mimicking ? " · impersonating" : ""}` : "defaults"}</span>
        </summary>
        <div className="mt-5 flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-text-muted">Auto-detected. Only change these if something&apos;s off.</p>
            <SmallButton icon="restart_alt" onClick={() => change({ authHeader: null, stripBeta: false, maxCompletionTokens: false, mimic: "none", customHeaders: "", overrides: {}, blockForeignTools: false, stripReasoning: false })}>Reset all</SmallButton>
          </div>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
            <div className="ep-blocks grid content-start gap-3 md:grid-cols-2 lg:grid-cols-1">
              <Block icon="swap_horiz" title="Protocol" sub="Which API shape to speak.">
                <div className="flex flex-col gap-3">
                  <Seg
                    label="Protocol" size="md" wrap
                    options={PROTO_OPTS}
                    value={proto as ProtoChoice}
                    disabled={(v) => (v === proto ? null : !canChangeProtocol || v === "auto" ? "Fixed when the endpoint was added" : null)}
                    onChange={(v) => { if (v !== "auto" && v !== proto) void onSave({}, { protocol: v }); }}
                  />
                  <p className="text-xs text-text-muted">Detected: <span className="font-medium text-text-main">{PROTOCOL_LABELS[detected || proto]}</span></p>
                </div>
              </Block>
              <Block icon="key" title="Auth" sub="How the key is sent upstream.">
                <Seg label="Auth" size="md" wrap options={AUTH_OPTS} value={effectiveAuth(draft, proto)} onChange={(v) => change({ authHeader: v })} />
              </Block>
              <Block icon="build" title="Compatibility fixes" sub="Quirks we can patch for you.">
                <div className="flex flex-col gap-3">
                  {showBeta && <SwitchRow className="" title="Strip all beta flags" desc="Off: drop only the flags it rejects. On: send none." checked={!!draft.stripBeta} onChange={(v) => change({ stripBeta: v })} />}
                  {showBeta && dropped.length > 0 && (
                    <div className="flex flex-col gap-1.5">
                      <p className="text-xs text-text-muted">Dropped because the endpoint rejected them:</p>
                      <div className="flex flex-wrap gap-1.5">
                        {dropped.map((fl) => (
                          <span key={fl} className="inline-flex items-center gap-1 rounded-full border border-border-subtle bg-surface px-2 py-0.5 font-mono text-[11px] text-text-muted">
                            {fl}
                            <button type="button" onClick={() => { setDraft((d) => ({ ...d, droppedBetas: dropped.filter((x) => x !== fl) })); void onSave({}, { removeDroppedBetas: [fl] }); }} aria-label={`Send ${fl} again`} className="material-symbols-outlined text-[13px] hover:text-text-main">close</button>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {showMax && <SwitchRow className="" title={<>Send <Code>max_completion_tokens</Code></>} label="Send max_completion_tokens" desc={<>Rename <Code>max_tokens</Code>.</>} checked={!!draft.maxCompletionTokens} onChange={(v) => change({ maxCompletionTokens: v })} />}
                </div>
              </Block>
              <Block icon="shield" title="Response protection" sub="Don't trust what comes back.">
                <div className="flex flex-col gap-3">
                  <SwitchRow className="" title="Block unexpected tool calls" desc="Drop calls to tools your client never offered." checked={!!draft.blockForeignTools} onChange={(v) => change({ blockForeignTools: v })} />
                  <SwitchRow className="" title="Strip reasoning" desc="For clients that choke on thinking blocks." checked={!!draft.stripReasoning} onChange={(v) => change({ stripReasoning: v })} />
                </div>
              </Block>
              <Block icon="theater_comedy" title="Client identity" sub="Pretend to be a specific tool." className={`ep-wide md:col-span-2 lg:col-span-1 ${mimicking ? "border-yellow-500/30" : ""}`}>
                <div className="-my-2">
                  <MimicRow quirks={draft} onChange={(p) => change(p, { debounce: p.customHeaders !== undefined })} />
                </div>
              </Block>
              <Block icon="link" title="URL" sub="Where requests go.">
                <div className="grid gap-3 sm:grid-cols-2">
                  <RawField id={f("path")} label="Path" hint="Replaces the detected path."><RawInput id={f("path")} raw={raw} k="path" placeholder={ph.path} onChange={setRaw} onBlur={flush} /></RawField>
                  <RawField id={f("query")} label="Query string" hint="Added to every request."><RawInput id={f("query")} raw={raw} k="query" placeholder={ph.query} onChange={setRaw} onBlur={flush} /></RawField>
                </div>
              </Block>
              <Block icon="lan" title="Connection" sub="Timeouts, retries, proxy.">
                <div className="grid grid-cols-2 gap-3">
                  <RawField id={f("timeout")} label="Timeout (s)"><RawInput id={f("timeout")} raw={raw} k="timeout" inputMode="numeric" placeholder={ph.timeout} onChange={setRaw} onBlur={flush} /></RawField>
                  <RawField id={f("retries")} label="Retries"><RawInput id={f("retries")} raw={raw} k="retries" inputMode="numeric" placeholder={ph.retries} onChange={setRaw} onBlur={flush} /></RawField>
                </div>
                <RawField id={f("proxy")} label="Proxy" hint="HTTP or SOCKS, this endpoint only."><RawInput id={f("proxy")} raw={raw} k="proxy" inputMode="url" placeholder={ph.proxy} onChange={setRaw} onBlur={flush} /></RawField>
              </Block>
              <Block icon="data_object" title="Headers" sub="Set or remove any header." className="ep-wide md:col-span-2 lg:col-span-1">
                <RawField id={f("headers")} label="Extra headers" hint={<><Code>name: value</Code> sets, <Code>-name</Code> removes.</>}>
                  <RawArea id={f("headers")} raw={raw} k="headers" rows={4} placeholder={ph.headers} onChange={setRaw} onBlur={flush} />
                </RawField>
              </Block>
              <Block icon="code_blocks" title="Body" sub="Reshape every request." className="ep-wide md:col-span-2 lg:col-span-1">
                <div className="grid gap-3 md:grid-cols-2">
                  <RawField id={f("body")} label="Merge into body (JSON)" hint={<>Deep-merged. <Code>null</Code> deletes a field.</>}>
                    <RawArea id={f("body")} raw={raw} k="body" rows={5} placeholder={ph.bodyShort} onChange={setRaw} onBlur={flush} />
                  </RawField>
                  <div className="flex flex-col gap-3">
                    <RawField id={f("drop")} label="Drop fields" hint="Comma or space separated."><RawInput id={f("drop")} raw={raw} k="drop" placeholder={ph.drop} onChange={setRaw} onBlur={flush} /></RawField>
                    <RawField id={f("models")} label="Rename models" hint={<><Code>ours =&gt; theirs</Code>, one per line.</>}><RawArea id={f("models")} raw={raw} k="models" rows={2} placeholder={ph.models} onChange={setRaw} onBlur={flush} /></RawField>
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-medium text-text-main">Streaming</p>
                  <Seg label="Streaming" options={STREAM_OPTS} value={raw.stream || "auto"} onChange={(v) => change({ overrides: { ...raw, stream: v } })} />
                </div>
              </Block>
            </div>
            <aside className="lg:sticky lg:top-6 lg:self-start">
              <div className="overflow-hidden rounded-[10px] border border-border-subtle bg-surface-2">
                <p className="border-b border-border-subtle px-3 py-2 text-xs font-medium text-text-muted">What gets sent</p>
                <RequestPreview baseUrl={node.baseUrl || ""} protocol={proto} model={model} apiKey={apiKey} keyPlaceholder="sk-…" quirks={draft} className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs text-text-main" />
                <p className="border-t border-border-subtle px-3 py-2 text-[11px] text-text-subtle">Sample request, key masked.</p>
              </div>
            </aside>
          </div>
        </div>
      </details>
    </div>
  );
}

function Block({ icon, title, sub, children, className = "" }: { icon: string; title: string; sub: string; children: ReactNode; className?: string }) {
  return (
    <section className={`flex flex-col gap-3 rounded-[10px] border border-border-subtle p-4 ${className}`}>
      <div className="flex items-start gap-2.5">
        <span aria-hidden="true" className="material-symbols-outlined mt-px text-[18px] text-text-subtle">{icon}</span>
        <div className="min-w-0"><h3 className="text-sm font-semibold text-text-main">{title}</h3><p className="text-xs text-text-muted">{sub}</p></div>
      </div>
      {children}
    </section>
  );
}
