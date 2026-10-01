"use client";

import { useEffect, useState } from "react";
import Card from "./Card";
import Button from "./Button";
import Input from "./Input";

export default function UsageHubSettings() {
  const [config, setConfig] = useState(null);
  const [key, setKey] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/settings/usage-hub").then(async (res) => {
      if (!res.ok) throw new Error("Could not load hub settings");
      const data = await res.json();
      if (active) {
        setConfig(data);
        setUrl(window.location.origin);
      }
    }).catch((err) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, []);

  async function update(method, body) {
    setBusy(true);
    setError("");
    setCopied(false);
    try {
      const res = await fetch("/api/settings/usage-hub", {
        method, headers: { "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not save hub settings");
      setConfig(data);
      if (data.managementKey) setKey(data.managementKey);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  return (
    <Card id="usage-hub" title="T3 usage hub" icon="hub">
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium">Share subscription quotas with T3 Code</p>
            <p className="text-sm text-text-muted">Show your Codex and Claude accounts through the CLIProxyAPI hub integration.</p>
          </div>
          <button type="button" role="switch" aria-label="Enable T3 usage hub" aria-checked={config?.enabled === true}
            disabled={!config || busy} onClick={() => update("PATCH", { enabled: !config.enabled })}
            className={`relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors focus:ring-2 focus:ring-brand-500/30 disabled:opacity-50 ${config?.enabled ? "bg-brand-500" : "bg-surface-3"}`}>
            <span className={`mt-0.5 size-5 rounded-full bg-white shadow-sm transition-transform ${config?.enabled ? "translate-x-5" : "translate-x-0.5"}`} />
          </button>
        </div>
        {config?.demo && <p className="rounded-lg bg-amber-500/10 p-3 text-sm text-amber-600 dark:text-amber-400">Demo mode: four fake subscriptions. Quotas and reset credits are simulated; no provider requests are made.</p>}
        {config?.enabled && <>
          <Input label="Hub URL" aria-label="Hub URL" value={url} readOnly />
          <p className="text-sm text-text-muted">In T3 Code, open Usage providers, choose Add hub, and paste this URL and your management key. Use a URL reachable from your T3 server.</p>
          {key ? <>
            <Input label="Management key" aria-label="Management key" value={key} readOnly />
            <p className="text-xs text-text-muted">Copy this key now. Only its hash is stored, so it cannot be shown again after a reload.</p>
            <Button variant="secondary" onClick={async () => {
              try { await navigator.clipboard.writeText(key); setCopied(true); }
              catch { setError("Clipboard unavailable. Select and copy the key above."); }
            }}>{copied ? "Copied" : "Copy management key"}</Button>
          </> : <p className="text-sm text-text-muted">A management key is configured. Generate a replacement if you no longer have it.</p>}
          <Button variant="secondary" disabled={busy} onClick={() => {
            if (window.confirm("Replace the management key? Existing hub connections will need the new key.")) update("POST");
          }}>Replace management key</Button>
          <p className="text-xs text-text-muted">The key allows quota reads and Codex reset-credit redemption. Turning this off immediately blocks hub access. Model routing is configured separately.</p>
        </>}
        {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
      </div>
    </Card>
  );
}
