"use client";

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { Button, Badge, ModelSelectModal } from "@/shared/components";

/**
 * A list of model ids: chips, a text box, and the model picker over active
 * connections and aliases. Used for a client key's allowlist and for a
 * management key's model scope.
 */
export default function ModelAllowlistField({ label, value, onChange, emptyText, placeholder, hint, pickerTitle }) {
  const [draft, setDraft] = useState("");
  const [showPicker, setShowPicker] = useState(false);
  const [activeProviders, setActiveProviders] = useState([]);
  const [modelAliases, setModelAliases] = useState({});

  // What the picker offers: active connections and model aliases.
  useEffect(() => {
    fetch("/api/providers").then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setActiveProviders((d.connections || []).filter((c) => c.isActive !== false)))
      .catch(() => {});
    fetch("/api/models/alias").then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setModelAliases(d.aliases || {}))
      .catch(() => {});
  }, []);

  const add = (id) => {
    const v = String(id || "").trim();
    if (!v || value.some((m) => m.toLowerCase() === v.toLowerCase())) return;
    onChange([...value, v]);
  };
  const remove = (id) => onChange(value.filter((m) => m !== id));
  const addDraft = () => { add(draft); setDraft(""); };

  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium">{label}</label>
      {value.length === 0 ? (
        <p className="text-xs text-text-muted">{emptyText}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {value.map((m) => (
            <Badge key={m} size="sm" className="pr-1 font-mono">
              {m}
              <button
                onClick={() => remove(m)}
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
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); addDraft(); }
          }}
          placeholder={placeholder}
          className="min-w-0 flex-1 rounded-[10px] border border-border bg-surface px-3 py-1.5 font-mono text-xs outline-none focus:border-primary"
        />
        <Button size="sm" variant="secondary" onClick={addDraft} disabled={!draft.trim()}>Add</Button>
        <Button size="sm" variant="outline" icon="list" onClick={() => setShowPicker(true)}>Pick</Button>
      </div>
      {hint && <p className="mt-1 text-[11px] text-text-muted">{hint}</p>}

      {showPicker && (
        <ModelSelectModal
          isOpen={showPicker}
          onClose={() => setShowPicker(false)}
          onSelect={(m) => add(m.value)}
          onDeselect={(m) => remove(m.value)}
          activeProviders={activeProviders}
          modelAliases={modelAliases}
          title={pickerTitle}
          addedModelValues={value}
          closeOnSelect={false}
        />
      )}
    </div>
  );
}

ModelAllowlistField.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.arrayOf(PropTypes.string).isRequired,
  onChange: PropTypes.func.isRequired,
  emptyText: PropTypes.string.isRequired,
  placeholder: PropTypes.string,
  hint: PropTypes.string,
  pickerTitle: PropTypes.string,
};
