"use client";

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { Button, Badge, ModelSelectModal } from "@/shared/components";

/**
 * A list of ids: chips, a text box, and (with pickerTitle) the model picker
 * over active connections and aliases. Used for a client key's allowlist, a
 * management key's model scope, and, with validate and no picker, its hosts.
 * `normalize` rewrites typed text before it's added; `validate` returns why
 * it can't be added, or null.
 */
export default function ModelAllowlistField({ label, value, onChange, emptyText, placeholder, hint, pickerTitle, normalize, validate, inputLabel }) {
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState("");
  const [showPicker, setShowPicker] = useState(false);
  const [activeProviders, setActiveProviders] = useState([]);
  const [modelAliases, setModelAliases] = useState({});

  // What the picker offers: active connections and model aliases.
  useEffect(() => {
    if (!pickerTitle) return;
    fetch("/api/providers").then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setActiveProviders((d.connections || []).filter((c) => c.isActive !== false)))
      .catch(() => {});
    fetch("/api/models/alias").then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setModelAliases(d.aliases || {}))
      .catch(() => {});
  }, [pickerTitle]);

  const add = (id) => {
    const v = String(id || "").trim();
    if (!v || value.some((m) => m.toLowerCase() === v.toLowerCase())) return;
    onChange([...value, v]);
  };
  const remove = (id) => onChange(value.filter((m) => m !== id));
  const addDraft = () => {
    const v = normalize ? normalize(draft.trim()) : draft.trim();
    const why = v && validate ? validate(v) : null;
    if (why) return setDraftError(`"${v}" ${why}.`);
    add(v);
    setDraft("");
    setDraftError("");
  };

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
          onChange={(e) => { setDraft(e.target.value); setDraftError(""); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); addDraft(); }
          }}
          placeholder={placeholder}
          aria-label={inputLabel || label}
          className="min-w-0 flex-1 rounded-[10px] border border-border bg-surface px-3 py-1.5 font-mono text-xs outline-none focus:border-primary"
        />
        <Button size="sm" variant="secondary" onClick={addDraft} disabled={!draft.trim()}>Add</Button>
        {pickerTitle && <Button size="sm" variant="outline" icon="list" onClick={() => setShowPicker(true)}>Pick</Button>}
      </div>
      {draftError && <p className="mt-1 text-[11px] text-red-500">{draftError}</p>}
      {hint && <p className="mt-1 text-[11px] text-text-muted">{hint}</p>}

      {pickerTitle && showPicker && (
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
  normalize: PropTypes.func,
  validate: PropTypes.func,
  inputLabel: PropTypes.string,
};
