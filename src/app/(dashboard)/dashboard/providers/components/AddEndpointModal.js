"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Badge, Button, Input, Modal, Toggle } from "@/shared/components";

const PROTOCOLS = {
  anthropic: { label: "Anthropic · Messages", nodeType: "anthropic-compatible" },
  "openai-chat": { label: "OpenAI · Chat Completions", nodeType: "openai-compatible", apiType: "chat" },
  "openai-responses": { label: "OpenAI · Responses", nodeType: "openai-compatible", apiType: "responses" },
};

const KEY_STATUS = {
  confirmed: "Key checked: a wrong key is refused.",
  likely: "Key accepted.",
  unknown: "Couldn't confirm the key. It will be checked on the first request.",
};

// Initials of a multi-part name, else its first 4 letters (matches detection).
function prefixFromName(name) {
  const words = String(name || "").replace(/([a-z])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean);
  return (words.length > 1 ? words.map((w) => w[0]).join("") : (words[0] || "").slice(0, 4)).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function guessName(raw) {
  try {
    const host = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname;
    const parts = host.split(".").filter((p) => !["api", "gateway", "llm", "www", "inference"].includes(p));
    const label = parts.length > 1 ? parts[parts.length - 2] : parts[0];
    const brand = (label || "").replace(/computing$/, "").replace(/-.*$/, "");
    return brand ? brand.charAt(0).toUpperCase() + brand.slice(1) : "";
  } catch { return ""; }
}

function ProbeList({ steps }) {
  if (!steps?.length) return null;
  return (
    <details className="group rounded-[10px] bg-surface-2">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-text-muted hover:text-text-main">
        <span className="material-symbols-outlined text-[16px] transition-transform group-open:rotate-90">chevron_right</span>
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
ProbeList.propTypes = { steps: PropTypes.array };

function AddEndpointModal({ isOpen, onClose, onCreated, takenPrefixes = [] }) {
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [phase, setPhase] = useState("idle"); // idle | detecting | found | failed
  const [result, setResult] = useState(null);
  const [name, setName] = useState("");
  const [prefix, setPrefix] = useState("");
  const [prefixEdited, setPrefixEdited] = useState(false);
  const [protocol, setProtocol] = useState(null);
  const [quirks, setQuirks] = useState({ stripBeta: false, maxCompletionTokens: false });
  const [manualModels, setManualModels] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const reset = () => {
    setUrl(""); setApiKey(""); setPhase("idle"); setResult(null); setName(""); setPrefix("");
    setPrefixEdited(false); setProtocol(null); setQuirks({ stripBeta: false, maxCompletionTokens: false });
    setManualModels(""); setError("");
  };
  const close = () => { reset(); onClose(); };

  const uniquePrefix = (p) => {
    const used = new Set(takenPrefixes.map((t) => String(t).toLowerCase()));
    if (!p || !used.has(p)) return p;
    for (let i = 2; ; i++) if (!used.has(`${p}${i}`)) return `${p}${i}`;
  };

  const detect = async () => {
    setPhase("detecting"); setError("");
    try {
      const res = await fetch("/api/provider-nodes/detect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, apiKey }),
      });
      const data = await res.json();
      setResult(data);
      if (data.ok) {
        setProtocol(data.protocol);
        setName(data.suggestedName || "");
        setPrefix(uniquePrefix(data.suggestedPrefix || prefixFromName(data.suggestedName)));
        setPrefixEdited(false);
        setQuirks((q) => ({ ...q, ...(data.quirks || {}) }));
        setPhase("found");
      } else {
        // Still offer a name from the host, so "Save anyway" is one click.
        const guess = guessName(data.baseUrl || url);
        if (!name && guess) { setName(guess); setPrefix(uniquePrefix(prefixFromName(guess))); }
        setPhase("failed");
      }
    } catch {
      setResult({ ok: false, error: "Network error", steps: [] });
      setPhase("failed");
    }
  };

  const onNameChange = (v) => {
    setName(v);
    if (!prefixEdited) setPrefix(uniquePrefix(prefixFromName(v)));
  };

  const save = async () => {
    const proto = PROTOCOLS[protocol || result?.protocol || "openai-chat"];
    const verified = phase === "found";
    const models = verified && result.models?.length
      ? result.models
      : manualModels.split(/[\s,]+/).map((m) => m.trim()).filter(Boolean);
    if (!name.trim() || !prefix.trim()) { setError("Name and prefix are required."); return; }
    setSaving(true); setError("");
    try {
      const nodeRes = await fetch("/api/provider-nodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          prefix: prefix.trim(),
          type: proto.nodeType,
          ...(proto.apiType ? { apiType: proto.apiType } : {}),
          baseUrl: result?.baseUrl || url,
          quirks,
          verified,
        }),
      });
      const nodeData = await nodeRes.json();
      if (!nodeRes.ok) { setError(nodeData.error || "Couldn't save the endpoint."); return; }
      const node = nodeData.node;

      if (apiKey.trim()) {
        const connRes = await fetch("/api/providers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: node.id,
            apiKey: apiKey.trim().replace(/^Bearer\s+/i, ""),
            defaultModel: models[0] || null,
            testStatus: verified ? "active" : "unknown",
          }),
        });
        if (!connRes.ok) {
          const d = await connRes.json().catch(() => ({}));
          setError(`Endpoint saved, but the key wasn't: ${d.error || connRes.status}`);
        }
      }
      for (const id of models) {
        await fetch("/api/models/custom", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ providerAlias: node.id, id, type: "llm" }),
        }).catch(() => {});
      }
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("customModelChanged"));
      onCreated(node);
      reset();
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  };

  const detected = result?.ok ? result : null;
  const available = detected?.protocols?.length ? detected.protocols : Object.keys(PROTOCOLS);
  const isAnthropic = (protocol || detected?.protocol) === "anthropic";

  return (
    <Modal isOpen={isOpen} title="Add endpoint" onClose={close}>
      <div className="flex flex-col gap-4">
        <Input
          label="Endpoint URL"
          icon="link"
          value={url}
          onChange={(e) => { setUrl(e.target.value); if (phase !== "idle") setPhase("idle"); }}
          placeholder="https://api.example.com/v1"
          hint="Any form works: base URL, /v1, /messages, /chat/completions."
          ignorePasswordManagers
        />
        <Input
          label="API key"
          icon="key"
          type="password"
          value={apiKey}
          onChange={(e) => { setApiKey(e.target.value); if (phase !== "idle") setPhase("idle"); }}
          hint="Optional for local servers that don't need one."
          ignorePasswordManagers
        />

        {(phase === "idle" || phase === "detecting") && (
          <>
            <Button icon="bolt" fullWidth onClick={detect} disabled={!url.trim() || phase === "detecting"}>
              {phase === "detecting" ? "Testing…" : "Connect"}
            </Button>
            <p className="text-center text-xs text-text-muted">
              We work out the API type, models and quirks with free requests only. Nothing gets generated.
            </p>
          </>
        )}

        {phase === "failed" && (
          <div className="flex items-start gap-2 rounded-[10px] border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-600 dark:text-red-400">
            <span className="material-symbols-outlined text-[18px]">error</span>
            <span>{result?.error || "Couldn't detect this endpoint."}</span>
          </div>
        )}

        {phase === "found" && detected && (
          <div className="flex flex-col gap-3 rounded-[10px] border border-green-500/20 bg-green-500/5 p-4">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[20px] text-green-500">check_circle</span>
              <span className="text-sm font-semibold text-text-main">It works</span>
              <span className="ml-auto"><Badge variant="success" size="sm">{PROTOCOLS[protocol]?.label}</Badge></span>
            </div>
            <p className="text-xs text-text-muted">{KEY_STATUS[detected.keyConfirmed] || KEY_STATUS.unknown}</p>
            {detected.models?.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <div className="flex flex-wrap gap-1.5">
                  {detected.models.slice(0, 8).map((m) => (
                    <span key={m} className="rounded-full border border-border-subtle bg-surface px-2 py-0.5 font-mono text-[11px] text-text-muted">{m}</span>
                  ))}
                  {detected.models.length > 8 && <span className="px-1 text-[11px] text-text-subtle">+{detected.models.length - 8} more</span>}
                </div>
                {(detected.modelsSource === "catalog" || detected.modelsSource === "guessed") && (
                  <p className="text-[11px] text-text-subtle">No model list here, so we checked known models one by one. Add any we missed on the endpoint page.</p>
                )}
              </div>
            ) : (
              <p className="text-xs text-text-muted">No model list found. Add model IDs below.</p>
            )}
            {isAnthropic && (
              <p className="flex items-start gap-1 text-xs text-text-muted">
                <span className="material-symbols-outlined text-[14px] text-primary">auto_fix_high</span>
                <span>Beta flags can&apos;t be checked for free. If a request is rejected for one, we drop that flag, retry, and remember it.</span>
              </p>
            )}
          </div>
        )}

        {(phase === "found" || phase === "failed") && (
          <>
            <ProbeList steps={result?.steps} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_8rem]">
              <Input label="Name" value={name} onChange={(e) => onNameChange(e.target.value)} placeholder="My endpoint" />
              <Input label="Prefix" value={prefix} onChange={(e) => { setPrefix(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "")); setPrefixEdited(true); }} placeholder="ep" hint={prefix ? `${prefix}/model-id` : ""} />
            </div>
            {(!detected || !detected.models?.length) && (
              <Input
                label="Model IDs"
                value={manualModels}
                onChange={(e) => setManualModels(e.target.value)}
                placeholder="model-a, model-b"
                hint="Comma or space separated."
              />
            )}

            <details className="group rounded-[10px] border border-border-subtle" open={phase === "failed"}>
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-text-muted hover:text-text-main">
                <span className="material-symbols-outlined text-[16px] transition-transform group-open:rotate-90">chevron_right</span>
                Advanced <span className="text-text-subtle">· if something&apos;s off</span>
              </summary>
              <div className="flex flex-col divide-y divide-border-subtle px-3 pb-2">
                <div className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <p className="text-sm font-medium text-text-main">API type</p>
                  <div className="inline-flex flex-wrap items-center gap-1 rounded-[10px] bg-surface-2 p-1">
                    {Object.entries(PROTOCOLS).map(([v, p]) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => setProtocol(v)}
                        className={`h-6 rounded-[8px] px-2.5 text-[11px] font-medium ${protocol === v ? "bg-surface text-text-main shadow-sm" : "text-text-muted hover:text-text-main"} ${available.includes(v) ? "" : "opacity-60"}`}
                      >
                        {p.label.split(" · ")[1]}
                      </button>
                    ))}
                  </div>
                </div>
                {isAnthropic && (
                  <div className="flex items-center justify-between gap-4 py-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text-main">Strip all beta flags</p>
                      <p className="text-xs text-text-muted">Off: drop only the flags it rejects. On: send no <code className="font-mono">anthropic-beta</code> at all.</p>
                    </div>
                    <Toggle checked={quirks.stripBeta} onChange={(v) => setQuirks((q) => ({ ...q, stripBeta: v }))} />
                  </div>
                )}
                {!isAnthropic && (
                  <div className="flex items-center justify-between gap-4 py-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text-main">Send <code className="font-mono">max_completion_tokens</code></p>
                      <p className="text-xs text-text-muted">Rename <code className="font-mono">max_tokens</code> for endpoints that reject it.</p>
                    </div>
                    <Toggle checked={quirks.maxCompletionTokens} onChange={(v) => setQuirks((q) => ({ ...q, maxCompletionTokens: v }))} />
                  </div>
                )}
              </div>
            </details>

            {error && <p className="text-sm text-red-500">{error}</p>}
            <div className="flex flex-col gap-2 sm:flex-row">
              {phase === "failed" && (
                <Button variant="secondary" icon="refresh" fullWidth onClick={detect}>Try again</Button>
              )}
              <Button fullWidth onClick={save} disabled={saving || !name.trim() || !prefix.trim() || (phase === "failed" && !protocol)}>
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

AddEndpointModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onCreated: PropTypes.func.isRequired,
  takenPrefixes: PropTypes.arrayOf(PropTypes.string),
};

export default AddEndpointModal;
