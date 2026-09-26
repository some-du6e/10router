"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Card, CardSkeleton } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";
import { DEFAULT_SLACK_FIELDS, normalizeSlackLayout, renderSlackTemplate } from "@/lib/notifications/slackLayout.js";

const SAMPLE_PAYLOAD = {
  provider: "OpenAI Codex",
  connection: { name: "Production" },
  quota: {
    name: "Weekly usage",
    remainingPercentage: 0,
    resetAt: "2026-08-24T16:00:00Z",
  },
};

function nextFieldId(fields) {
  const used = new Set(fields.map((field) => field.id));
  let number = fields.length + 1;
  while (used.has(`field-${number}`)) number += 1;
  return `field-${number}`;
}

function EditableText({ value, onCommit, className, ariaLabel }) {
  return (
    <span
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      role="textbox"
      tabIndex={0}
      aria-label={ariaLabel}
      className={className}
      onBlur={(event) => onCommit(event.currentTarget.textContent || "")}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
    >
      {value}
    </span>
  );
}

function EditableTemplateValue({ template, onCommit }) {
  const ref = useRef(null);
  const rendered = renderSlackTemplate(template, SAMPLE_PAYLOAD);

  return (
    <span
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      role="textbox"
      tabIndex={0}
      aria-label="Field value template"
      title={`Template: ${template}`}
      className="block min-h-5 cursor-text rounded-[4px] font-normal outline-none focus:bg-blue-500/10"
      onFocus={(event) => {
        event.currentTarget.textContent = template;
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(event.currentTarget);
        selection.removeAllRanges();
        selection.addRange(range);
      }}
      onBlur={(event) => onCommit(event.currentTarget.textContent || "")}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
    >
      {rendered}
    </span>
  );
}

function SlackField({ field, onChange, onRemove, onDragStart, onDrop }) {
  return (
    <div
      data-field-id={field.id}
      className="group relative min-h-[58px] rounded-[7px] border border-dashed border-white/25 px-7 py-2 text-sm transition-colors hover:border-blue-400 focus-within:border-blue-400 dark:border-white/25"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        onDrop(field.id);
      }}
    >
      <button
        type="button"
        draggable
        onDragStart={() => onDragStart(field.id)}
        className="absolute left-1 top-1/2 -translate-y-1/2 cursor-grab text-white/35 hover:text-white/70 active:cursor-grabbing"
        title="Drag field"
        aria-label={`Drag ${field.label}`}
      >
        <span className="material-symbols-outlined text-[16px]">drag_indicator</span>
      </button>
      <button
        type="button"
        onClick={() => onRemove(field.id)}
        className="absolute right-1 top-1 text-white/35 hover:text-white"
        title="Remove field"
        aria-label={`Remove ${field.label}`}
      >
        <span className="material-symbols-outlined text-[15px]">close</span>
      </button>
      <EditableText
        value={field.label}
        onCommit={(label) => onChange(field.id, { label })}
        ariaLabel="Field label"
        className="block min-h-5 cursor-text rounded-[4px] font-bold outline-none focus:bg-blue-500/10"
      />
      <EditableTemplateValue
        template={field.value}
        onCommit={(value) => onChange(field.id, { value })}
      />
    </div>
  );
}

export default function SlackLayoutEditor({ channelId }) {
  const [channel, setChannel] = useState(null);
  const [fields, setFields] = useState(() => DEFAULT_SLACK_FIELDS.map((field) => ({ ...field })));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [appearance, setAppearance] = useState("dark");
  const draggedId = useRef(null);
  const notify = useNotificationStore();

  const loadChannel = useCallback(async () => {
    try {
      const response = await fetch(`/api/notifications/channels/${encodeURIComponent(channelId)}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to load notification channel");
      if (data.channel.type !== "slack") throw new Error("This notification channel is not a Slack channel");
      setChannel(data.channel);
      setFields(normalizeSlackLayout(data.channel.config?.slackLayout).fields);
    } catch (error) {
      notify.error(error.message);
    } finally {
      setLoading(false);
    }
  }, [channelId, notify]);

  useEffect(() => {
    const timer = setTimeout(loadChannel, 0);
    return () => clearTimeout(timer);
  }, [loadChannel]);

  const updateField = (id, patch) => {
    setFields((current) => current.map((field) => field.id === id ? { ...field, ...patch } : field));
  };

  const removeField = (id) => {
    setFields((current) => current.length > 1 ? current.filter((field) => field.id !== id) : current);
  };

  const moveField = (targetId) => {
    const sourceId = draggedId.current;
    draggedId.current = null;
    if (!sourceId || sourceId === targetId) return;
    setFields((current) => {
      const sourceIndex = current.findIndex((field) => field.id === sourceId);
      const targetIndex = current.findIndex((field) => field.id === targetId);
      if (sourceIndex < 0 || targetIndex < 0) return current;
      const next = [...current];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
  };

  const addField = () => {
    setFields((current) => current.length >= 10 ? current : [
      ...current,
      { id: nextFieldId(current), label: "New field", value: "{{provider}}" },
    ]);
  };

  const save = async () => {
    if (!channel) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/notifications/channels/${encodeURIComponent(channelId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...channel,
          config: { ...channel.config, slackLayout: { fields } },
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to save Slack layout");
      setChannel(data.channel);
      setFields(normalizeSlackLayout(data.channel.config?.slackLayout).fields);
      notify.success("Slack layout saved");
    } catch (error) {
      notify.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      const response = await fetch(`/api/notifications/channels/${encodeURIComponent(channelId)}/test`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Test notification failed");
      notify.success("Test notification sent");
    } catch (error) {
      notify.error(error.message);
    } finally {
      setTesting(false);
    }
  };

  if (loading) return <div className="mx-auto w-full max-w-6xl"><CardSkeleton /></div>;
  if (!channel) return (
    <Card className="mx-auto w-full max-w-xl text-center">
      <p className="text-sm text-text-muted">This Slack notification channel could not be loaded.</p>
      <Link href="/dashboard/notifications" className="mt-4 inline-block text-sm font-semibold text-primary">Back to Notifications</Link>
    </Card>
  );

  const dark = appearance === "dark";

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 sm:gap-6">
      <div>
        <Link href="/dashboard/notifications" className="inline-flex items-center gap-1 text-xs font-medium text-text-muted hover:text-primary">
          <span className="material-symbols-outlined text-[16px]">arrow_back</span>
          Notifications
        </Link>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-xl font-semibold sm:text-2xl">Slack message</h1>
            <p className="mt-1 text-sm text-text-muted">Edit {channel.name}&apos;s fields directly in the message canvas.</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={sendTest} loading={testing}>Send test</Button>
            <Button onClick={save} loading={saving}>Save changes</Button>
          </div>
        </div>
      </div>

      <Card padding="none" className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-border-subtle px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-sm font-semibold text-text-main">Message canvas</h2>
            <p className="mt-0.5 text-xs text-text-muted">Drag fields. Click a label or value to edit its template.</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" icon="add" onClick={addField} disabled={fields.length >= 10}>Add field</Button>
            <div className="flex rounded-[8px] bg-surface-2 p-1">
              {["dark", "light"].map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setAppearance(value)}
                  className={`rounded-[6px] px-3 py-1 text-[11px] font-semibold capitalize ${appearance === value ? "bg-surface text-text-main shadow-sm" : "text-text-muted"}`}
                >
                  {value}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="bg-[radial-gradient(circle_at_center,rgba(236,72,153,0.08)_0_1px,transparent_1.3px)] bg-[length:15px_15px] p-3 sm:p-8">
          <div className={`mx-auto max-w-3xl rounded-[10px] border p-4 shadow-xl sm:p-6 ${dark ? "border-[#36393d] bg-[#1a1d21] text-[#d1d2d3]" : "border-[#dedede] bg-white text-[#1d1c1d]"}`}>
            <div className="flex items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-[8px] bg-gradient-to-br from-sky-400 to-blue-700 text-xs font-bold text-white">10r</div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-1.5 text-sm">
                  <strong>10router</strong>
                  <span className={`rounded px-1 py-0.5 text-[8px] font-bold ${dark ? "bg-[#34373b] text-[#b9b9ba]" : "bg-[#e8e8e8] text-[#616061]"}`}>APP</span>
                  <span className={dark ? "text-[#ababad]" : "text-[#616061]"}>8:51 PM</span>
                </div>
                <p className="mt-0.5 text-sm">Codex quota exhausted</p>
                <div className="relative mt-2 border-l-4 border-[#e98300] pl-4">
                  <div className={`mb-4 text-sm font-bold ${dark ? "text-[#ababad]" : "text-[#616061]"}`}>⚠️ QUOTA EXHAUSTED · <span className="font-normal">10router</span></div>
                  <h3 className="text-sm font-bold">Codex quota exhausted</h3>
                  <p className="text-sm">Requests will automatically fall back to the next available account.</p>
                  <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {fields.map((field) => (
                      <SlackField
                        key={field.id}
                        field={field}
                        onChange={updateField}
                        onRemove={removeField}
                        onDragStart={(id) => { draggedId.current = id; }}
                        onDrop={moveField}
                      />
                    ))}
                  </div>
                  <p className={`mt-3 text-xs ${dark ? "text-[#ababad]" : "text-[#616061]"}`}>0% remaining · automatic fallback is active</p>
                  <p className={`mt-2 text-xs ${dark ? "text-[#ababad]" : "text-[#616061]"}`}>Added by <span className="text-[#1d9bd1]">10router</span></p>
                </div>
              </div>
            </div>
          </div>
          <p className="mx-auto mt-3 max-w-3xl text-xs text-text-muted">Value templates: {"{{provider}}"}, {"{{account}}"}, {"{{limit}}"}, {"{{resetAt}}"}, {"{{remaining}}"}.</p>
        </div>
      </Card>
    </div>
  );
}
