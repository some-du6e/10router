"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Card, Toggle } from "@/shared/components";

// Compatibility fixes for a user-added endpoint. Saved on the node; the node PUT
// copies them onto every key so the executor applies them. `onSave(quirks, extra)`
// sends only what changed: the server merges, so learned fields (droppedBetas,
// modelRoutes) survive a toggle.
export default function EndpointQuirksCard({ node, isAnthropic, onSave }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const dropped = node.droppedBetas || [];
  // A two-path node also sends some models down its other API; show that API's fixes too.
  const routed = new Set(Object.values(node.modelRoutes || {}));
  const showBeta = isAnthropic || routed.has("anthropic");
  const showMaxTokens = !isAnthropic || routed.has("openai-chat");
  const twoPath = isAnthropic ? showMaxTokens : showBeta;
  const active = [node.stripBeta && "strip beta", dropped.length && `${dropped.length} dropped flag${dropped.length === 1 ? "" : "s"}`, node.maxCompletionTokens && "max_completion_tokens"].filter(Boolean);

  const save = async (quirks, extra) => {
    setSaving(true);
    try { await onSave(quirks, extra); }
    finally { setSaving(false); }
  };

  return (
    <Card>
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 text-left text-sm text-text-muted hover:text-text-main" aria-expanded={open}>
        <span aria-hidden="true" className={`material-symbols-outlined text-[18px] transition-transform ${open ? "rotate-90" : ""}`}>chevron_right</span>
        <span className="font-medium">Advanced</span>
        <span className="text-text-subtle">· compatibility fixes</span>
        <span className="ml-auto text-xs text-text-subtle">{active.length ? active.join(" · ") : "defaults"}</span>
      </button>
      {open && (
        <div className="mt-4 flex flex-col divide-y divide-border-subtle">
          {showBeta && (
            <div className="flex flex-col gap-3 py-3">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-text-main">Strip all beta flags{twoPath && <span className="ml-1 text-xs font-normal text-text-subtle">· Messages API</span>}</p>
                  <p className="text-xs text-text-muted">Off: drop only the <code className="font-mono">anthropic-beta</code> flags this endpoint rejects (learned automatically). On: send none.</p>
                </div>
                <Toggle checked={!!node.stripBeta} disabled={saving} onChange={(v) => save({ stripBeta: v })} />
              </div>
              {dropped.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <p className="text-xs text-text-muted">Dropped because the endpoint rejected them:</p>
                  <div className="flex flex-wrap gap-1.5">
                    {dropped.map((f) => (
                      <span key={f} className="inline-flex items-center gap-1 rounded-full border border-border-subtle bg-surface px-2 py-0.5 font-mono text-[11px] text-text-muted">
                        {f}
                        <button type="button" disabled={saving} onClick={() => save({}, { removeDroppedBetas: [f] })} aria-label={`Send ${f} again`} className="material-symbols-outlined text-[13px] hover:text-text-main">close</button>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          {showMaxTokens && (
            <div className="flex items-center justify-between gap-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-text-main">Send <code className="font-mono">max_completion_tokens</code>{twoPath && <span className="ml-1 text-xs font-normal text-text-subtle">· Chat Completions</span>}</p>
                <p className="text-xs text-text-muted">Rename <code className="font-mono">max_tokens</code> for endpoints that reject it.</p>
              </div>
              <Toggle checked={!!node.maxCompletionTokens} disabled={saving} onChange={(v) => save({ maxCompletionTokens: v })} />
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

EndpointQuirksCard.propTypes = {
  node: PropTypes.object.isRequired,
  isAnthropic: PropTypes.bool,
  onSave: PropTypes.func.isRequired,
};
