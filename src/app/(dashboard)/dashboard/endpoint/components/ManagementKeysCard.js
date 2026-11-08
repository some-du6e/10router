"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, Button, Input, Modal, Toggle, ConfirmModal } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { describeScopes } from "@/shared/utils/managementKey.js";
import { isKeyExpired } from "@/shared/utils/apiKeyLimits.js";
import ManagementKeyModal from "./ManagementKeyModal";
import StatusAlert from "./StatusAlert";

const ACTION_LABELS = {
  "management_key.create": "created in the dashboard",
  "management_key.update": "changed in the dashboard",
  "management_key.revoke": "revoked in the dashboard",
  "client_key.create": "created client key",
  "client_key.update": "edited client key",
  "client_key.delete": "deleted client key",
  "client_key.create.denied": "was refused a client key",
  "client_key.update.denied": "was refused an edit to client key",
  "provider_key.create": "added provider key",
  "provider_key.delete": "deleted provider key",
  "provider_key.create.denied": "was refused a provider key",
};

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString() : "never");

/**
 * Management keys: scoped keys for /api/management/v1 that can manage client
 * keys and provider keys without dashboard access. Lists them with what each
 * created, and the recent audit log. See docs/MANAGEMENT_KEYS.md.
 */
export default function ManagementKeysCard() {
  const [keys, setKeys] = useState([]);
  const [audit, setAudit] = useState([]);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null); // null | "new" | key
  const [secret, setSecret] = useState(null);
  const [revoking, setRevoking] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());
  const { copied, copy } = useCopyToClipboard();

  const [version, setVersion] = useState(0);
  const load = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let live = true;
    fetch("/api/management-keys", { cache: "no-store" })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Could not load management keys");
        return data;
      })
      .then((data) => {
        if (!live) return;
        setKeys(data.managementKeys || []);
        setAudit(data.audit || []);
        setError("");
      })
      .catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [version]);

  const patch = async (id, body) => {
    const res = await fetch(`/api/management-keys/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) setError(data.error || "Could not update the key");
    load();
  };

  const revoke = async (id) => {
    setRevoking(null);
    const res = await fetch(`/api/management-keys/${id}`, { method: "DELETE" });
    if (!res.ok) setError("Could not revoke the key");
    load();
  };

  const nameOf = (id, detail) => keys.find((k) => k.id === id)?.name || detail?.name || "a revoked key";
  const toggleExpanded = (id) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <Card id="management-keys">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">admin_panel_settings</span>
          Management Keys
        </h2>
        <Button icon="add" onClick={() => setEditing("new")}>Create Key</Button>
      </div>
      <p className="text-sm text-text-muted mb-4">
        Keys for the management API (<code>/api/management/v1</code>). Each one can only manage the client keys or provider keys
        its scope allows, without dashboard access. They don&apos;t work on <code>/v1</code>.
      </p>

      {error && <div className="mb-4"><StatusAlert status={{ type: "error", message: error }} /></div>}

      {keys.length === 0 ? (
        <p className="text-sm text-text-muted py-4 text-center">No management keys yet.</p>
      ) : (
        <div className="flex flex-col">
          {keys.map((k) => {
            const expired = isKeyExpired(k);
            const made = k.created || { clientKeys: [], providerKeys: [] };
            const madeCount = made.clientKeys.length + made.providerKeys.length;
            return (
              <div key={k.id} className={`group py-3 border-b border-black/[0.03] dark:border-white/[0.03] last:border-b-0 ${!k.isActive || expired ? "opacity-60" : ""}`}>
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <div className="flex-1 min-w-[14rem]">
                    <p className="text-sm font-medium">{k.name}</p>
                    <code className="text-xs text-text-muted font-mono">{k.keyPrefix}…</code>
                    <p className="text-xs text-text-muted mt-1">{describeScopes(k.scopes)}</p>
                    <p className="text-xs text-text-muted mt-1">
                      Created {new Date(k.createdAt).toLocaleDateString()} · Last used {fmtDate(k.lastUsedAt)}
                      {k.expiresAt ? ` · ${expired ? "Expired" : "Expires"} ${fmtDate(k.expiresAt)}` : ""}
                    </p>
                    {!k.isActive && <p className="text-xs text-orange-500 mt-1">Turned off</p>}
                    {madeCount > 0 && (
                      <button onClick={() => toggleExpanded(k.id)} className="text-xs text-primary mt-1 hover:underline">
                        Created {made.clientKeys.length} client key{made.clientKeys.length === 1 ? "" : "s"}, {made.providerKeys.length} provider key{made.providerKeys.length === 1 ? "" : "s"}
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-2 ml-auto">
                    <button
                      onClick={() => setEditing(k)}
                      className="p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-muted hover:text-primary transition-all"
                      title="Edit scopes and expiry"
                      aria-label={`Edit ${k.name}`}
                    >
                      <span className="material-symbols-outlined text-[18px]">tune</span>
                    </button>
                    <Toggle size="sm" checked={k.isActive} onChange={() => patch(k.id, { isActive: !k.isActive })} ariaLabel={k.isActive ? "Turn off" : "Turn on"} />
                    <button
                      onClick={() => setRevoking(k)}
                      className="p-2 hover:bg-red-500/10 rounded text-red-500 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-all"
                      title="Revoke"
                      aria-label={`Revoke ${k.name}`}
                    >
                      <span className="material-symbols-outlined text-[18px]">delete</span>
                    </button>
                  </div>
                </div>
                {expanded.has(k.id) && madeCount > 0 && (
                  <ul className="mt-2 ml-1 text-xs text-text-muted flex flex-col gap-0.5">
                    {made.clientKeys.map((c) => <li key={c.id}>Client key: {c.name}{c.isActive === false ? " (paused)" : ""}</li>)}
                    {made.providerKeys.map((p) => <li key={p.id}>Provider key: {p.provider} · {p.name}{p.isActive === false ? " (off)" : ""}</li>)}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}

      {audit.length > 0 && (
        <div className="mt-4 pt-4 border-t border-border">
          <p className="text-sm font-medium mb-2">Recent activity</p>
          <ul className="flex flex-col gap-1 text-xs text-text-muted max-h-64 overflow-y-auto">
            {audit.slice(0, 30).map((a) => (
              <li key={a.id} className={a.action.endsWith(".denied") ? "text-orange-500" : ""}>
                <span className="tabular-nums">{new Date(a.at).toLocaleString()}</span>
                {" · "}
                <span className="font-medium text-text-main">{nameOf(a.managementKeyId, a.detail)}</span>
                {" "}{ACTION_LABELS[a.action] || a.action}
                {a.detail?.name && a.targetType !== "managementKey" ? ` "${a.detail.name}"` : ""}
                {a.detail?.provider ? ` (${a.detail.provider})` : ""}
                {a.detail?.reason ? `: ${a.detail.reason}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      {editing && (
        <ManagementKeyModal
          key={editing === "new" ? "new" : editing.id}
          managementKey={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(data) => {
            if (data.secret) setSecret(data.secret);
            load();
          }}
        />
      )}

      <Modal isOpen={!!secret} title="Management key created" onClose={() => setSecret(null)}>
        <div className="flex flex-col gap-4">
          <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
            <p className="text-sm text-yellow-800 dark:text-yellow-200 mb-2 font-medium">Save this key now!</p>
            <p className="text-sm text-yellow-700 dark:text-yellow-300">
              This is the only time you will see it. 10router keeps only a hash, so it can&apos;t be shown again.
            </p>
          </div>
          <div className="flex gap-2">
            <Input value={secret || ""} readOnly className="flex-1 font-mono text-sm" />
            <Button
              variant="secondary"
              icon={copied === "created_mgmt_key" ? "check" : "content_copy"}
              onClick={() => copy(secret, "created_mgmt_key")}
            >
              {copied === "created_mgmt_key" ? "Copied!" : "Copy"}
            </Button>
          </div>
          <Button onClick={() => setSecret(null)} fullWidth>Done</Button>
        </div>
      </Modal>

      <ConfirmModal
        isOpen={!!revoking}
        onClose={() => setRevoking(null)}
        onConfirm={() => revoke(revoking.id)}
        title="Revoke management key"
        message={revoking ? `Revoke "${revoking.name}"? It stops working at once. The keys it created stay.` : ""}
      />
    </Card>
  );
}
