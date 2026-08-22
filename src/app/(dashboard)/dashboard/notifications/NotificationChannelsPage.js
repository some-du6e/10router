"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, CardSkeleton, ConfirmModal, Input, Modal, Select, Toggle } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";
import { NOTIFICATION_EVENTS, NOTIFICATION_TYPE_OPTIONS } from "@/lib/notifications/constants";

const EMPTY_FORM = {
  name: "",
  type: "ntfy",
  isActive: true,
  events: [NOTIFICATION_EVENTS.QUOTA_EXHAUSTED, NOTIFICATION_EVENTS.QUOTA_RESET],
  config: { serverUrl: "https://ntfy.sh", priority: "default", method: "POST" },
};

const TYPE_META = Object.fromEntries(NOTIFICATION_TYPE_OPTIONS.map((option) => [option.value, option]));

function formFromChannel(channel) {
  if (!channel) return { ...EMPTY_FORM, config: { ...EMPTY_FORM.config } };
  const config = { ...(channel.config || {}) };
  return {
    name: channel.name,
    type: channel.type,
    isActive: channel.isActive,
    events: [...(channel.events || [])],
    config,
    headersJson: channel.type === "webhook" && channel.configuredSecrets?.headers
      ? ""
      : undefined,
  };
}

function SecretInput({ label, field, form, setConfig, placeholder }) {
  const configured = form.configuredSecrets?.[field];
  return (
    <Input
      label={label}
      type="password"
      value={form.config[field] || ""}
      onChange={(event) => setConfig(field, event.target.value)}
      placeholder={configured ? "Saved — leave blank to keep" : placeholder}
    />
  );
}

async function readApiResponse(response, fallbackMessage) {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    const contentType = response.headers.get("content-type") || "";
    const isHtml = contentType.includes("text/html") || /^\s*<!doctype html/i.test(text);
    if (isHtml) {
      throw new Error(`${fallbackMessage} (server returned HTML with status ${response.status})`);
    }
    throw new Error(`${fallbackMessage} (invalid server response)`);
  }
}

function ChannelFields({ form, setConfig }) {
  switch (form.type) {
    case "ntfy":
      return (
        <>
          <Input label="Server URL" value={form.config.serverUrl || ""} onChange={(event) => setConfig("serverUrl", event.target.value)} placeholder="https://ntfy.sh" required />
          <Input label="Topic" value={form.config.topic || ""} onChange={(event) => setConfig("topic", event.target.value)} placeholder="10router-alerts" required />
          <SecretInput label="Access token (optional)" field="token" form={form} setConfig={setConfig} placeholder="tk_..." />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input label="Username (optional)" value={form.config.username || ""} onChange={(event) => setConfig("username", event.target.value)} />
            <SecretInput label="Password" field="password" form={form} setConfig={setConfig} placeholder="Password" />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Select label="Priority" value={form.config.priority || "default"} onChange={(event) => setConfig("priority", event.target.value)} options={["default", "min", "low", "high", "max"].map((value) => ({ value, label: value }))} />
            <Input label="Tags (optional)" value={form.config.tags || ""} onChange={(event) => setConfig("tags", event.target.value)} placeholder="warning,robot" />
          </div>
        </>
      );
    case "slack":
      return (
        <>
          <SecretInput label="Incoming webhook URL" field="webhookUrl" form={form} setConfig={setConfig} placeholder="https://hooks.slack.com/services/..." />
          <p className="text-xs text-text-muted">
            Need a webhook URL? Follow the{" "}
            <a
              href="https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              Slack incoming webhooks guide
            </a>.
          </p>
        </>
      );
    case "webhook":
      return (
        <>
          <Input label="Webhook URL" value={form.config.url || ""} onChange={(event) => setConfig("url", event.target.value)} placeholder="https://example.com/hooks/10router" required />
          <Select label="Method" value={form.config.method || "POST"} onChange={(event) => setConfig("method", event.target.value)} options={["POST", "PUT", "PATCH"].map((value) => ({ value, label: value }))} />
          <SecretInput label="Bearer token (optional)" field="bearerToken" form={form} setConfig={setConfig} placeholder="Token" />
          <div>
            <label className="mb-1.5 block text-sm font-medium text-text-main">Custom headers (JSON)</label>
            <textarea
              value={form.headersJson ?? JSON.stringify(form.config.headers || {}, null, 2)}
              onChange={(event) => setConfig("headersJson", event.target.value, true)}
              placeholder={form.configuredSecrets?.headers
                ? "Saved — leave blank to keep"
                : '{\n  "X-Webhook-Secret": "..."\n}'}
              className="min-h-28 w-full rounded-[10px] border border-transparent bg-surface-2 px-3 py-2.5 font-mono text-sm text-text-main outline-none focus:border-brand-500/40 focus:ring-2 focus:ring-brand-500/30"
            />
          </div>
        </>
      );
    case "telegram":
      return (
        <>
          <SecretInput label="Bot token" field="botToken" form={form} setConfig={setConfig} placeholder="123456:ABC..." />
          <Input label="Chat ID" value={form.config.chatId || ""} onChange={(event) => setConfig("chatId", event.target.value)} placeholder="-1001234567890" required />
          <Input label="Message thread ID (optional)" value={form.config.messageThreadId || ""} onChange={(event) => setConfig("messageThreadId", event.target.value)} />
          <Toggle checked={form.config.disableNotification === true} onChange={(value) => setConfig("disableNotification", value)} label="Send silently" />
        </>
      );
    case "apprise":
      return (
        <>
          <Input label="Apprise API URL" value={form.config.apiUrl || ""} onChange={(event) => setConfig("apiUrl", event.target.value)} placeholder="http://apprise-api:8000" required />
          <Input label="Persistent config key (optional)" value={form.config.configKey || ""} onChange={(event) => setConfig("configKey", event.target.value)} placeholder="10router" />
          <div>
            <label className="mb-1.5 block text-sm font-medium text-text-main">Service URLs</label>
            <textarea
              value={form.config.serviceUrls || ""}
              onChange={(event) => setConfig("serviceUrls", event.target.value)}
              placeholder="discord://...\nmailto://..."
              className="min-h-28 w-full rounded-[10px] border border-transparent bg-surface-2 px-3 py-2.5 font-mono text-sm text-text-main outline-none focus:border-brand-500/40 focus:ring-2 focus:ring-brand-500/30"
            />
            <p className="mt-1 text-xs text-text-muted">Use a config key or paste one Apprise service URL per line.</p>
          </div>
        </>
      );
    default:
      return null;
  }
}

export default function NotificationChannelsPage() {
  const [channels, setChannels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(formFromChannel());
  const [showModal, setShowModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const notify = useNotificationStore();

  const loadChannels = useCallback(async () => {
    try {
      const response = await fetch("/api/notifications/channels", { cache: "no-store" });
      const data = await readApiResponse(response, "Failed to load channels");
      if (!response.ok) throw new Error(data.error || "Failed to load channels");
      setChannels(data.channels || []);
    } catch (error) {
      notify.error(error.message);
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    const timer = setTimeout(() => loadChannels(), 0);
    return () => clearTimeout(timer);
  }, [loadChannels]);

  const activeCount = useMemo(() => channels.filter((channel) => channel.isActive).length, [channels]);

  const openCreate = () => {
    setEditing(null);
    setForm(formFromChannel());
    setShowModal(true);
  };

  const openEdit = (channel) => {
    setEditing(channel);
    setForm({ ...formFromChannel(channel), configuredSecrets: channel.configuredSecrets || {} });
    setShowModal(true);
  };

  const setConfig = (field, value, formOnly = false) => {
    if (formOnly) {
      setForm((current) => ({ ...current, headersJson: value }));
      return;
    }
    setForm((current) => ({ ...current, config: { ...current.config, [field]: value } }));
  };

  const toggleEvent = (event) => {
    setForm((current) => ({
      ...current,
      events: current.events.includes(event)
        ? current.events.filter((value) => value !== event)
        : [...current.events, event],
    }));
  };

  const saveChannel = async () => {
    setSaving(true);
    try {
      const config = { ...form.config };
      if (form.type === "webhook") {
        config.headers = form.headersJson === undefined
          ? config.headers || {}
          : JSON.parse(form.headersJson || "{}");
      }
      const payload = {
        name: form.name,
        type: form.type,
        isActive: form.isActive,
        events: form.events,
        config,
      };
      const response = await fetch(editing ? `/api/notifications/channels/${editing.id}` : "/api/notifications/channels", {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await readApiResponse(response, "Failed to save channel");
      if (!response.ok) throw new Error(data.error || "Failed to save channel");
      await loadChannels();
      setShowModal(false);
      notify.success(editing ? "Notification channel updated" : "Notification channel created");
    } catch (error) {
      notify.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (channel) => {
    setChannels((current) => current.map((item) => item.id === channel.id ? { ...item, isActive: !channel.isActive } : item));
    try {
      const response = await fetch(`/api/notifications/channels/${channel.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...channel, isActive: !channel.isActive }),
      });
      if (!response.ok) throw new Error("Failed to update channel");
    } catch (error) {
      await loadChannels();
      notify.error(error.message);
    }
  };

  const testChannel = async (id) => {
    setTestingId(id);
    try {
      const response = await fetch(`/api/notifications/channels/${id}/test`, { method: "POST" });
      const data = await readApiResponse(response, "Test notification failed");
      if (!response.ok) throw new Error(data.error || "Test notification failed");
      notify.success("Test notification sent");
    } catch (error) {
      notify.error(error.message);
    } finally {
      setTestingId(null);
    }
  };

  const deleteChannel = async () => {
    const channel = deleting;
    setDeleting(null);
    try {
      const response = await fetch(`/api/notifications/channels/${channel.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Failed to delete notification channel");
      setChannels((current) => current.filter((item) => item.id !== channel.id));
      notify.success("Notification channel deleted");
    } catch (error) {
      notify.error(error.message);
    }
  };

  if (loading) return <div className="mx-auto flex w-full max-w-5xl flex-col gap-4"><CardSkeleton /><CardSkeleton /></div>;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 sm:gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold sm:text-2xl">Notifications</h1>
          <p className="mt-1 text-sm text-text-muted">Send alerts when a provider quota is exhausted or becomes available again.</p>
        </div>
        <Button size="sm" icon="add" onClick={openCreate}>Add Channel</Button>
      </div>

      <Card>
        <div className="mb-4 flex flex-wrap gap-2">
          <Badge>Total: {channels.length}</Badge>
          <Badge variant="success">Active: {activeCount}</Badge>
        </div>
        {channels.length === 0 ? (
          <div className="py-12 text-center">
            <span className="material-symbols-outlined text-[52px] text-text-muted/30">notifications_off</span>
            <h2 className="mt-3 font-semibold text-text-main">No notification channels</h2>
            <p className="mx-auto mt-1 max-w-md text-sm text-text-muted">Add ntfy, Slack, Telegram, a generic webhook, or an Apprise API server.</p>
            <Button className="mt-4" icon="add" onClick={openCreate}>Add Channel</Button>
          </div>
        ) : (
          <div className="divide-y divide-border-subtle">
            {channels.map((channel) => {
              const type = TYPE_META[channel.type] || { label: channel.type, icon: "notifications" };
              return (
                <div key={channel.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-primary/10 text-primary">
                      <span className="material-symbols-outlined">{type.icon}</span>
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="truncate text-sm font-semibold text-text-main">{channel.name}</h2>
                        <Badge size="sm">{type.label}</Badge>
                        <Badge size="sm" variant={channel.isActive ? "success" : "default"}>{channel.isActive ? "active" : "inactive"}</Badge>
                      </div>
                      <p className="mt-1 text-xs text-text-muted">
                        {(channel.events || []).map((event) => event === NOTIFICATION_EVENTS.QUOTA_EXHAUSTED ? "Quota exhausted" : "Quota reset").join(" · ")}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center justify-end gap-1">
                    <Toggle size="sm" checked={channel.isActive} onChange={() => toggleActive(channel)} />
                    <button type="button" onClick={() => testChannel(channel.id)} disabled={testingId === channel.id} title="Send test" className="p-2 text-text-muted hover:text-primary disabled:opacity-50">
                      <span className={`material-symbols-outlined text-[19px] ${testingId === channel.id ? "animate-spin" : ""}`}>{testingId === channel.id ? "progress_activity" : "science"}</span>
                    </button>
                    <button type="button" onClick={() => openEdit(channel)} title="Edit" className="p-2 text-text-muted hover:text-primary"><span className="material-symbols-outlined text-[19px]">edit</span></button>
                    <button type="button" onClick={() => setDeleting(channel)} title="Delete" className="p-2 text-red-500 hover:bg-red-500/10"><span className="material-symbols-outlined text-[19px]">delete</span></button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Modal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        title={editing ? "Edit Notification Channel" : "Add Notification Channel"}
        size="lg"
        footer={<><Button variant="ghost" onClick={() => setShowModal(false)} disabled={saving}>Cancel</Button><Button onClick={saveChannel} loading={saving}>Save Channel</Button></>}
      >
        <div className="flex flex-col gap-4">
          <Input label="Name" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="Ops alerts" required />
          <Select
            label="Service"
            value={form.type}
            onChange={(event) => setForm({ ...formFromChannel(), name: form.name, type: event.target.value, isActive: form.isActive, events: form.events })}
            options={NOTIFICATION_TYPE_OPTIONS}
          />
          <ChannelFields form={form} setConfig={setConfig} />
          {form.type !== "telegram" && form.type !== "slack" && (
            <Toggle
              checked={form.config.allowPrivateNetwork === true}
              onChange={(value) => setConfig("allowPrivateNetwork", value)}
              label="Allow private-network destination"
              description="Required for a self-hosted ntfy, webhook, or Apprise server on localhost/LAN. Only enable for a server you trust."
            />
          )}
          <div className="rounded-[10px] border border-border-subtle bg-surface-2 p-3">
            <p className="mb-2 text-sm font-medium text-text-main">Events</p>
            <div className="space-y-2">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-text-main"><input type="checkbox" checked={form.events.includes(NOTIFICATION_EVENTS.QUOTA_EXHAUSTED)} onChange={() => toggleEvent(NOTIFICATION_EVENTS.QUOTA_EXHAUSTED)} /> Quota exhausted</label>
              <label className="flex cursor-pointer items-center gap-2 text-sm text-text-main"><input type="checkbox" checked={form.events.includes(NOTIFICATION_EVENTS.QUOTA_RESET)} onChange={() => toggleEvent(NOTIFICATION_EVENTS.QUOTA_RESET)} /> Quota reset</label>
            </div>
          </div>
          <Toggle checked={form.isActive} onChange={(value) => setForm((current) => ({ ...current, isActive: value }))} label="Channel enabled" />
        </div>
      </Modal>

      <ConfirmModal
        isOpen={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={deleteChannel}
        title="Delete Notification Channel"
        message={deleting ? `Delete “${deleting.name}”?` : ""}
        confirmText="Delete"
      />
    </div>
  );
}
