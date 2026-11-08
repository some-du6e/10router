"use client";

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { Modal, Button, Input, ModelSelectModal, ConfirmModal, Badge } from "@/shared/components";
import { budgetState } from "@/shared/utils/apiKeyLimits.js";
import { fmtUsdExact, isoToLocalInput, localInputToIso } from "./keyFormat";
import StatusAlert from "./StatusAlert";

/**
 * Edit one key's limits: budget, allowed models, expiry, and reset its spend.
 * Mount it per key (key={apiKey.id}) while open; the form starts from the
 * key's saved limits. Saves through PUT /api/keys/[id]; onSaved gets the updated key.
 */
export default function KeyLimitsModal({ apiKey, onClose, onSaved, requireApiKey }) {
  const [budget, setBudget] = useState(apiKey.budgetUsd === null || apiKey.budgetUsd === undefined ? "" : String(apiKey.budgetUsd));
  const [models, setModels] = useState(apiKey.allowedModels || []);
  const [modelDraft, setModelDraft] = useState("");
  const [expiry, setExpiry] = useState(isoToLocalInput(apiKey.expiresAt));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [showModelSelect, setShowModelSelect] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [activeProviders, setActiveProviders] = useState([]);
  const [modelAliases, setModelAliases] = useState({});

  // What the model picker offers: active connections and model aliases.
  useEffect(() => {
    fetch("/api/providers").then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setActiveProviders((d.connections || []).filter((c) => c.isActive !== false)))
      .catch(() => {});
    fetch("/api/models/alias").then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setModelAliases(d.aliases || {}))
      .catch(() => {});
  }, []);

  const spend = budgetState(apiKey);

  const addModel = (id) => {
    const value = String(id || "").trim();
    if (!value || models.some((m) => m.toLowerCase() === value.toLowerCase())) return;
    setModels((prev) => [...prev, value]);
  };
  const removeModel = (id) => setModels((prev) => prev.filter((m) => m !== id));

  const put = async (payload) => {
    const res = await fetch(`/api/keys/${apiKey.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Could not save the limits");
    return data.key;
  };

  const handleSave = async () => {
    // Blank (spaces included) clears the budget, as the API does.
    const trimmed = budget.trim();
    if (trimmed && (!Number.isFinite(Number(trimmed)) || Number(trimmed) < 0)) {
      setError("Budget must be a dollar amount of 0 or more, or empty for no budget.");
      return;
    }
    if (expiry && !localInputToIso(expiry)) {
      setError("Expiry is not a valid date.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const key = await put({
        budgetUsd: trimmed === "" ? null : Number(trimmed),
        allowedModels: models.length ? models : null,
        expiresAt: localInputToIso(expiry),
      });
      onSaved(key);
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setConfirmReset(false);
    setSaving(true);
    setError("");
    try {
      onSaved(await put({ resetSpend: true }));
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Modal isOpen onClose={onClose} title={`Limits for "${apiKey.name}"`} size="lg">
        <div className="flex flex-col gap-4">
          {!requireApiKey && (
            <StatusAlert status={{ type: "warning", message: "\"Require API key\" is off, so a client can skip these limits by sending no key at all." }} />
          )}

          <div>
            <Input
              label="Budget (USD)"
              type="number"
              min="0"
              step="0.01"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              placeholder="No budget"
              hint="Requests are refused once the key has spent this much. Leave empty for no budget. To top up, raise it."
            />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-2 px-3 py-2 text-xs">
              <span className="tabular-nums">
                Spent {fmtUsdExact(spend.spentUsd)}
                {apiKey.spendResetAt ? ` since ${new Date(apiKey.spendResetAt).toLocaleDateString()}` : ""}
                {apiKey.lifetimeSpentUsd > spend.spentUsd ? ` · ${fmtUsdExact(apiKey.lifetimeSpentUsd)} lifetime` : ""}
              </span>
              <Button size="sm" variant="outline" icon="restart_alt" disabled={saving || spend.spentUsd === 0} onClick={() => setConfirmReset(true)}>
                Reset spend
              </Button>
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium">Allowed models</label>
            {models.length === 0 ? (
              <p className="text-xs text-text-muted">Every model. Add one to allow only the models listed.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {models.map((m) => (
                  <Badge key={m} size="sm" className="pr-1 font-mono">
                    {m}
                    <button
                      onClick={() => removeModel(m)}
                      className="rounded p-0.5 text-text-muted hover:text-red-500"
                      title={`Remove ${m}`}
                      aria-label={`Remove ${m}`}
                    >
                      <span className="material-symbols-outlined text-[14px]">close</span>
                    </button>
                  </Badge>
                ))}
              </div>
            )}
            <div className="mt-2 flex gap-2">
              <input
                value={modelDraft}
                onChange={(e) => setModelDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); addModel(modelDraft); setModelDraft(""); }
                }}
                placeholder="Model id, alias or combo (e.g. claude-opus-5-5)"
                className="min-w-0 flex-1 rounded-[10px] border border-border bg-surface px-3 py-1.5 font-mono text-xs outline-none focus:border-primary"
              />
              <Button size="sm" variant="secondary" onClick={() => { addModel(modelDraft); setModelDraft(""); }} disabled={!modelDraft.trim()}>
                Add
              </Button>
              <Button size="sm" variant="outline" icon="list" onClick={() => setShowModelSelect(true)}>
                Pick
              </Button>
            </div>
            <p className="mt-1 text-[11px] text-text-muted">
              A bare id allows that model from any provider. An alias or combo is allowed when everything it points to is.
            </p>
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
            <Button onClick={handleSave} fullWidth disabled={saving}>{saving ? "Saving..." : "Save limits"}</Button>
            <Button onClick={onClose} variant="ghost" fullWidth>Cancel</Button>
          </div>
        </div>
      </Modal>

      {showModelSelect && (
        <ModelSelectModal
          isOpen={showModelSelect}
          onClose={() => setShowModelSelect(false)}
          onSelect={(m) => addModel(m.value)}
          onDeselect={(m) => removeModel(m.value)}
          activeProviders={activeProviders}
          modelAliases={modelAliases}
          title="Allow models"
          addedModelValues={models}
          closeOnSelect={false}
        />
      )}

      <ConfirmModal
        isOpen={confirmReset}
        onClose={() => setConfirmReset(false)}
        onConfirm={handleReset}
        title="Reset spend"
        message={`Start "${apiKey.name}" back at $0 against its budget? Its usage history is kept.`}
      />
    </>
  );
}

KeyLimitsModal.propTypes = {
  apiKey: PropTypes.object.isRequired,
  onClose: PropTypes.func.isRequired,
  onSaved: PropTypes.func.isRequired,
  requireApiKey: PropTypes.bool,
};
