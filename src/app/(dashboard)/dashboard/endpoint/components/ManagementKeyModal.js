"use client";

import { useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
import { Modal, Button, Input, Select, Toggle, Badge } from "@/shared/components";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { isoToLocalInput, localInputToIso } from "./keyFormat";
import StatusAlert from "./StatusAlert";
import ModelAllowlistField from "./ModelAllowlistField";

function Chips({ items, onRemove, empty }) {
  if (!items.length) return <p className="text-xs text-text-muted">{empty}</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <Badge key={item.value} size="sm" className="pr-1 font-mono">
          {item.label}
          <button
            onClick={() => onRemove(item.value)}
            className="rounded p-0.5 text-text-muted hover:text-red-500"
            title={`Remove ${item.label}`}
            aria-label={`Remove ${item.label}`}
          >
            <span className="material-symbols-outlined text-[14px]">close</span>
          </button>
        </Badge>
      ))}
    </div>
  );
}

Chips.propTypes = {
  items: PropTypes.arrayOf(PropTypes.shape({ value: PropTypes.string, label: PropTypes.string })).isRequired,
  onRemove: PropTypes.func.isRequired,
  empty: PropTypes.string.isRequired,
};

/** Pick provider ids: built-in providers and the custom endpoints (provider nodes). */
function ProviderPicker({ value, onChange, options, empty }) {
  const labelOf = (id) => options.find((o) => o.value === id)?.label || id;
  const add = (id) => id && !value.includes(id) && onChange([...value, id]);
  return (
    <div className="flex flex-col gap-2">
      <Chips items={value.map((id) => ({ value: id, label: labelOf(id) }))} onRemove={(id) => onChange(value.filter((v) => v !== id))} empty={empty} />
      <Select
        value=""
        onChange={(e) => add(e.target.value)}
        placeholder="Add a provider…"
        options={options.filter((o) => !value.includes(o.value))}
      />
    </div>
  );
}

ProviderPicker.propTypes = {
  value: PropTypes.arrayOf(PropTypes.string).isRequired,
  onChange: PropTypes.func.isRequired,
  options: PropTypes.array.isRequired,
  empty: PropTypes.string.isRequired,
};

const blankScopes = () => ({
  clientKeys: { enabled: false, providers: [], models: [], maxBudgetUsd: "", manageExisting: false },
  providerKeys: { enabled: false, providers: [], manageExisting: false },
});

function fromSaved(scopes) {
  const s = blankScopes();
  if (!scopes) return s;
  const ck = scopes.clientKeys || {};
  const pk = scopes.providerKeys || {};
  return {
    clientKeys: {
      enabled: !!ck.enabled, providers: ck.providers || [], models: ck.models || [],
      maxBudgetUsd: ck.maxBudgetUsd === null || ck.maxBudgetUsd === undefined ? "" : String(ck.maxBudgetUsd),
      manageExisting: !!ck.manageExisting,
    },
    providerKeys: { enabled: !!pk.enabled, providers: pk.providers || [], manageExisting: !!pk.manageExisting },
  };
}

function toPayload(s) {
  const budget = s.clientKeys.maxBudgetUsd.trim();
  return {
    clientKeys: {
      enabled: s.clientKeys.enabled,
      providers: s.clientKeys.providers.length ? s.clientKeys.providers : null,
      models: s.clientKeys.models.length ? s.clientKeys.models : null,
      maxBudgetUsd: budget === "" ? null : Number(budget),
      manageExisting: s.clientKeys.manageExisting,
    },
    providerKeys: {
      enabled: s.providerKeys.enabled,
      providers: s.providerKeys.providers.length ? s.providerKeys.providers : null,
      manageExisting: s.providerKeys.manageExisting,
    },
  };
}

/**
 * Create or edit a management key: name, expiry and scopes. Saves through
 * /api/management-keys; onSaved gets the response body (with the secret, on create).
 */
export default function ManagementKeyModal({ managementKey, onClose, onSaved }) {
  const editing = !!managementKey;
  const [name, setName] = useState(managementKey?.name || "");
  const [expiry, setExpiry] = useState(isoToLocalInput(managementKey?.expiresAt));
  const [scopes, setScopes] = useState(() => fromSaved(managementKey?.scopes));
  const [nodes, setNodes] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/provider-nodes").then((r) => (r.ok ? r.json() : null)).then((d) => d && setNodes(d.nodes || [])).catch(() => {});
  }, []);

  const providerOptions = useMemo(() => {
    const builtIn = Object.values(AI_PROVIDERS).map((p) => ({ value: p.id, label: p.name || p.id }));
    const custom = nodes.map((n) => ({ value: n.id, label: `${n.name || n.id} (custom)` }));
    return [...custom, ...builtIn.sort((a, b) => a.label.localeCompare(b.label))];
  }, [nodes]);

  const setClient = (patch) => setScopes((s) => ({ ...s, clientKeys: { ...s.clientKeys, ...patch } }));
  const setProvider = (patch) => setScopes((s) => ({ ...s, providerKeys: { ...s.providerKeys, ...patch } }));

  const handleSave = async () => {
    if (!name.trim()) return setError("Give the key a name.");
    if (!scopes.clientKeys.enabled && !scopes.providerKeys.enabled) return setError("Turn on client keys, provider keys, or both.");
    const budget = scopes.clientKeys.maxBudgetUsd.trim();
    if (budget && (!Number.isFinite(Number(budget)) || Number(budget) < 0)) return setError("Budget cap must be a dollar amount of 0 or more.");
    if (expiry && !localInputToIso(expiry)) return setError("Expiry is not a valid date.");
    setSaving(true);
    setError("");
    try {
      const res = await fetch(editing ? `/api/management-keys/${managementKey.id}` : "/api/management-keys", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), expiresAt: localInputToIso(expiry), scopes: toPayload(scopes) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not save the management key");
      onSaved(data);
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const ck = scopes.clientKeys;
  const pk = scopes.providerKeys;

  return (
    <>
      <Modal isOpen onClose={onClose} title={editing ? `Edit "${managementKey.name}"` : "Create management key"} size="lg">
        <div className="flex flex-col gap-4">
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Key rotation script" />

          <div className="rounded-lg border border-border p-3 flex flex-col gap-3">
            <Toggle
              checked={ck.enabled}
              onChange={() => setClient({ enabled: !ck.enabled })}
              label="Client keys"
              ariaLabel="Client keys"
              description="List, create, edit and delete 10router API keys."
            />
            {ck.enabled && (
              <>
                <div>
                  <label className="mb-1.5 block text-sm font-medium">Only for providers</label>
                  <ProviderPicker
                    value={ck.providers}
                    onChange={(providers) => setClient({ providers })}
                    options={providerOptions}
                    empty="Any provider. Add one to require every key it makes to allow only that provider's models."
                  />
                </div>
                <ModelAllowlistField
                  label="Only for models"
                  value={ck.models}
                  onChange={(models) => setClient({ models })}
                  emptyText="Any model."
                  placeholder="provider/model (e.g. openai/gpt-5)"
                  pickerTitle="Scope models"
                />
                <Input
                  label="Budget cap per key (USD)"
                  type="number"
                  min="0"
                  step="0.01"
                  value={ck.maxBudgetUsd}
                  onChange={(e) => setClient({ maxBudgetUsd: e.target.value })}
                  placeholder="No cap"
                  hint="Set a cap and every key it creates must have a budget no higher than this."
                />
                <Toggle
                  size="sm"
                  checked={ck.manageExisting}
                  onChange={() => setClient({ manageExisting: !ck.manageExisting })}
                  label="Also manage existing keys"
                  ariaLabel="Also manage existing keys"
                  description="See, edit and delete every client key inside this scope, not just the ones it created."
                />
              </>
            )}
          </div>

          <div className="rounded-lg border border-border p-3 flex flex-col gap-3">
            <Toggle
              checked={pk.enabled}
              onChange={() => setProvider({ enabled: !pk.enabled })}
              label="Provider keys"
              ariaLabel="Provider keys"
              description="Add, list and delete upstream API keys in the pool. Secrets are never returned."
            />
            {pk.enabled && (
              <>
                <div>
                  <label className="mb-1.5 block text-sm font-medium">Only for providers</label>
                  <ProviderPicker
                    value={pk.providers}
                    onChange={(providers) => setProvider({ providers })}
                    options={providerOptions}
                    empty="Any provider."
                  />
                </div>
                <Toggle
                  size="sm"
                  checked={pk.manageExisting}
                  onChange={() => setProvider({ manageExisting: !pk.manageExisting })}
                  label="Also manage existing keys"
                  ariaLabel="Also manage existing keys"
                  description="See and delete every key of these providers, not just the ones it added."
                />
              </>
            )}
          </div>

          <Input
            label="Expires"
            type="datetime-local"
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
            hint="Leave empty for a key that never expires."
          />

          {error && <StatusAlert status={{ type: "error", message: error }} />}

          <div className="flex gap-2">
            <Button onClick={handleSave} fullWidth disabled={saving}>{saving ? "Saving..." : editing ? "Save" : "Create"}</Button>
            <Button onClick={onClose} variant="ghost" fullWidth>Cancel</Button>
          </div>
        </div>
      </Modal>

    </>
  );
}

ManagementKeyModal.propTypes = {
  managementKey: PropTypes.object,
  onClose: PropTypes.func.isRequired,
  onSaved: PropTypes.func.isRequired,
};
