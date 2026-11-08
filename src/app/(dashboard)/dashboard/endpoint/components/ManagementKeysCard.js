"use client";

import { useCallback, useEffect, useState } from "react";
import PropTypes from "prop-types";
import { Card, Button, Modal, Toggle } from "@/shared/components";
import { describeScopes } from "@/shared/utils/managementKey.js";
import { isKeyExpired } from "@/shared/utils/apiKeyLimits.js";
import ManagementKeyModal from "./ManagementKeyModal";
import CreatedSecretModal from "./CreatedSecretModal";
import StatusAlert from "./StatusAlert";

const ACTION_LABELS = {
  "management_key.create": "created in the dashboard",
  "management_key.update": "changed in the dashboard",
  "management_key.revoke": "revoked in the dashboard",
  "management_key.revoke_and_delete": "revoked in the dashboard, with the keys it created",
  "client_key.create": "created client key",
  "client_key.update": "edited client key",
  "client_key.delete": "deleted client key",
  "client_key.create.denied": "was refused a client key",
  "client_key.update.denied": "was refused an edit to client key",
  "provider_key.create": "added provider key",
  "provider_key.delete": "deleted provider key",
  "provider_key.create.denied": "was refused a provider key",
};

const DELETED = "deleted management key";
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString() : "never");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function CreatedList({ created }) {
  return (
    <ul className="mt-2 ml-1 text-xs text-text-muted flex flex-col gap-0.5">
      {created.clientKeys.map((c) => <li key={c.id}>Client key: {c.name}{c.isActive === false ? " (paused)" : ""}</li>)}
      {created.providerKeys.map((p) => <li key={p.id}>Provider key: {p.provider} · {p.name}{p.isActive === false ? " (off)" : ""}</li>)}
      {created.clientKeyCount + created.providerKeyCount > created.clientKeys.length + created.providerKeys.length && <li>…and more</li>}
    </ul>
  );
}

CreatedList.propTypes = { created: PropTypes.object.isRequired };

/**
 * Management keys: scoped keys for /api/management/v1 that can manage client
 * keys and provider keys without dashboard access. Lists them with what each
 * created, and the recent audit log. See docs/MANAGEMENT_KEYS.md.
 */
export default function ManagementKeysCard({ onKeysLoaded, onRowsChanged }) {
  const [keys, setKeys] = useState([]);
  const [orphans, setOrphans] = useState([]);
  const [audit, setAudit] = useState([]);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null); // null | "new" | key
  const [secret, setSecret] = useState(null);
  const [revoking, setRevoking] = useState(null); // { id, name, created }
  const [deleteCreated, setDeleteCreated] = useState(false);
  const [expanded, setExpanded] = useState(() => new Set());
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
        setOrphans(data.orphans || []);
        setAudit(data.audit || []);
        setError("");
        onKeysLoaded?.(Object.fromEntries((data.managementKeys || []).map((k) => [k.id, k.name])));
      })
      .catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [version, onKeysLoaded]);

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

  const revoke = async () => {
    const target = revoking;
    setRevoking(null);
    const res = await fetch(`/api/management-keys/${target.id}${deleteCreated ? "?deleteCreated=1" : ""}`, { method: "DELETE" });
    if (!res.ok) setError("Could not revoke the key");
    if (deleteCreated) onRowsChanged?.();
    load();
  };

  const openRevoke = (target) => {
    setDeleteCreated(false);
    setRevoking(target);
  };

  // The actor is always the key the row names, never a name from the entry's detail.
  const nameOf = (id) => keys.find((k) => k.id === id)?.name || DELETED;
  const toggleExpanded = (id) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <Card id="management-keys">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">shield</span>
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
            const made = k.created;
            const madeCount = made.clientKeyCount + made.providerKeyCount;
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
                        Created {plural(made.clientKeyCount, "client key")}, {plural(made.providerKeyCount, "provider key")}
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
                      onClick={() => openRevoke({ id: k.id, name: k.name, created: made })}
                      className="p-2 hover:bg-red-500/10 rounded text-red-500 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-all"
                      title="Revoke"
                      aria-label={`Revoke ${k.name}`}
                    >
                      <span className="material-symbols-outlined text-[18px]">delete</span>
                    </button>
                  </div>
                </div>
                {expanded.has(k.id) && madeCount > 0 && <CreatedList created={made} />}
              </div>
            );
          })}
        </div>
      )}

      {orphans.length > 0 && (
        <div className="mt-4 pt-4 border-t border-border">
          <p className="text-sm font-medium mb-1">Made by deleted management keys</p>
          {orphans.map((o) => (
            <div key={o.managementKeyId} className="py-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-text-muted">
                  {plural(o.clientKeyCount, "client key")}, {plural(o.providerKeyCount, "provider key")}
                </p>
                <Button size="sm" variant="outline" onClick={() => { setDeleteCreated(true); setRevoking({ id: o.managementKeyId, name: DELETED, created: o, orphan: true }); }}>
                  Delete these
                </Button>
              </div>
              <CreatedList created={o} />
            </div>
          ))}
        </div>
      )}

      {audit.length > 0 && (
        <div className="mt-4 pt-4 border-t border-border">
          <p className="text-sm font-medium mb-2">Recent activity</p>
          <ul className="flex flex-col gap-1 text-xs text-text-muted max-h-64 overflow-y-auto">
            {audit.map((a) => (
              <li key={a.id} className={a.denied ? "text-orange-500" : ""}>
                <span className="tabular-nums">{new Date(a.at).toLocaleString()}</span>
                {" · "}
                <span className="font-medium text-text-main">{nameOf(a.managementKeyId)}</span>
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

      <CreatedSecretModal
        secret={secret}
        title="Management key created"
        note="This is the only time you will see it. 10router keeps only a hash, so it can't be shown again."
        onClose={() => setSecret(null)}
      />

      <Modal isOpen={!!revoking} title={revoking?.orphan ? "Delete keys" : "Revoke management key"} onClose={() => setRevoking(null)}>
        {revoking && (
          <div className="flex flex-col gap-4">
            <p className="text-sm">
              {revoking.orphan
                ? `Delete the keys a deleted management key created (${plural(revoking.created.clientKeyCount, "client key")}, ${plural(revoking.created.providerKeyCount, "provider key")})? They stop working at once.`
                : `Revoke "${revoking.name}"? It stops working at once.`}
            </p>
            {!revoking.orphan && revoking.created.clientKeyCount + revoking.created.providerKeyCount > 0 && (
              <Toggle
                checked={deleteCreated}
                onChange={() => setDeleteCreated(!deleteCreated)}
                label="Also delete everything it created"
                ariaLabel="Also delete everything it created"
                description={`${plural(revoking.created.clientKeyCount, "client key")} and ${plural(revoking.created.providerKeyCount, "provider key")}. Otherwise they stay, marked as made by a deleted management key.`}
              />
            )}
            <div className="flex gap-2">
              <Button variant="danger" onClick={revoke} fullWidth>{revoking.orphan ? "Delete" : deleteCreated ? "Revoke and delete" : "Revoke"}</Button>
              <Button variant="ghost" onClick={() => setRevoking(null)} fullWidth>Cancel</Button>
            </div>
          </div>
        )}
      </Modal>
    </Card>
  );
}

ManagementKeysCard.propTypes = {
  onKeysLoaded: PropTypes.func,
  onRowsChanged: PropTypes.func,
};
