"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ComponentType, type CSSProperties, type ReactNode } from "react";
import * as Shared from "@/shared/components/index.js";
import SharedProviderIcon from "@/shared/components/ProviderIcon.js";
import { useBlurEmails } from "@/shared/hooks/useBlurEmails.js";
import { AI_PROVIDERS } from "@/shared/constants/providers.js";
import { useNotificationStore } from "@/store/notificationStore.js";
import api from "@/shared/utils/api.js";
import { PROXY_DIRECT, normalizeLayerSetting, oneEachAssignments, oneEachPools, proxyExit, resolveProxyChain, type ProxyPoolLike, type ResolvedProxy } from "@/lib/network/proxyRouting.js";

// The shared components are untyped JavaScript; these are the props used here.
const Badge = Shared.Badge as unknown as ComponentType<{ variant?: string; size?: string; icon?: string; className?: string; children?: ReactNode }>;
const Button = Shared.Button as unknown as ComponentType<{ variant?: string; size?: string; icon?: string; loading?: boolean; disabled?: boolean; onClick?: () => void; children?: ReactNode }>;
const Card = Shared.Card as unknown as ComponentType<{ title?: string; subtitle?: string; icon?: string; children?: ReactNode }>;
const Select = Shared.Select as unknown as ComponentType<{
  value: string; options: { value: string; label: string }[]; onChange: (e: ChangeEvent<HTMLSelectElement>) => void;
  placeholder?: string; disabled?: boolean; "aria-label"?: string;
}>;
const ProviderIcon = SharedProviderIcon as unknown as ComponentType<{ providerId: string; size?: number; className?: string }>;
const ConfirmModal = Shared.ConfirmModal as unknown as ComponentType<{
  isOpen: boolean; onClose: () => void; onConfirm: () => void; title?: string; message?: ReactNode;
  confirmText?: string; variant?: string; loading?: boolean;
}>;


// The Select's placeholder option owns "", so Inherit needs its own value.
const INHERIT = "__inherit__";
const LEGACY = "__legacy__";
const MAX_ACCOUNTS = 4;
const STEP_MS = 140;

interface Connection {
  id: string;
  provider: string;
  name?: string;
  displayName?: string;
  email?: string;
  providerSpecificData?: Record<string, unknown>;
}

interface Settings {
  providerStrategies?: Record<string, Record<string, unknown> | undefined>;
  globalProxyPoolId?: string | null;
  outboundProxyEnabled?: boolean;
  outboundProxyUrl?: string;
}

type Selection = { type: "account"; id: string } | { type: "provider"; id: string } | { type: "global" };
// `id` is the account tested and `run` the test, so only the latest test's result is shown, and only for its account.
type TestState = null | { id: string; run: number; status: "running" } | { id: string; run: number; status: "done"; ok: boolean; text: string };
type Role = "selected" | "winner" | "path" | "dim";

const ROLE_CLASS: Record<Role, string> = {
  selected: "border-brand-500/50 bg-brand-500/5 ring-2 ring-brand-500/20",
  winner: "border-brand-500/40 bg-brand-500/5",
  path: "border-brand-500/25 bg-surface",
  dim: "border-border-subtle bg-surface opacity-55",
};
const LAYER_INDEX = { account: 0, provider: 1, global: 2, system: 2 } as const;

const delay = (ms: number): CSSProperties => ({ animationDelay: `${ms}ms` });
const providerName = (id: string, conns: Connection[]) =>
  (AI_PROVIDERS as Record<string, { name?: string } | undefined>)[id]?.name ||
  String(conns.find((c) => c.provider === id)?.providerSpecificData?.nodeName || id);
// Protocol, host and port only: a proxy URL can carry user:pass.
function maskProxyUrl(raw: string): string {
  if (!raw) return "";
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}`;
  } catch {
    return "";
  }
}
const accountName = (c: Connection) => c.displayName || c.name || c.email || c.id;

function Note({ icon, tone, children, alert = false }: { icon: string; tone: string; children: ReactNode; alert?: boolean }) {
  return (
    <p role={alert ? "alert" : undefined} className={`flex items-start gap-1.5 text-xs ${tone}`}>
      <span className="material-symbols-outlined mt-px shrink-0 text-[16px]">{icon}</span>
      <span>{children}</span>
    </p>
  );
}

const TONE = {
  ok: "text-green-600 dark:text-green-400",
  warn: "text-amber-700 dark:text-amber-300",
  error: "text-red-600 dark:text-red-400",
  muted: "text-text-muted",
};

export default function ProxyRoutingCard({ proxyPools, poolsLoaded, poolsError = "", onPoolsChanged }: {
  proxyPools: ProxyPoolLike[]; poolsLoaded: boolean; poolsError?: string; onPoolsChanged: () => unknown;
}) {
  const notify = useNotificationStore();
  const { blurClass } = useBlurEmails();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [confirmOneEach, setConfirmOneEach] = useState<string | null>(null);
  const [testState, setTest] = useState<TestState>(null);
  const testRun = useRef(0);

  const load = useCallback(async () => {
    try {
      const [connData, settingsData] = await Promise.all([
        api.get("/api/providers", { cache: "no-store" }) as Promise<{ connections?: (Connection & { isActive?: boolean })[] }>,
        api.get("/api/settings", { cache: "no-store" }) as Promise<Settings>,
      ]);
      // Turned-off accounts send nothing, so they have no route to show.
      setConnections((connData?.connections || []).filter((c) => c.isActive !== false));
      setSettings(settingsData);
      setLoadError("");
    } catch (error) {
      // Keep what loaded last; editing stays off until both reads succeed.
      setLoadError(error instanceof Error ? error.message : "Request failed");
    }
  }, []);

  useEffect(() => {
    const timeoutId = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(timeoutId);
  }, [load]);

  const pools = useMemo(() => Object.fromEntries(proxyPools.map((p) => [p.id, p])), [proxyPools]);
  const strategies = settings?.providerStrategies || {};
  const providerSetting = (pid: string) => normalizeLayerSetting(strategies[pid]?.proxyPoolId);
  const globalSetting = normalizeLayerSetting(settings?.globalProxyPoolId);
  const hasLegacy = (c: Connection) => c.providerSpecificData?.connectionProxyEnabled === true && !!c.providerSpecificData?.connectionProxyUrl;
  const accountSetting = (c: Connection) => normalizeLayerSetting(c.providerSpecificData?.proxyPoolId) || (hasLegacy(c) ? LEGACY : null);

  const resolveAccount = (c: Connection) => resolveProxyChain({
    account: c.providerSpecificData, provider: strategies[c.provider]?.proxyPoolId, global: settings?.globalProxyPoolId, pools,
  });
  const resolveProvider = (pid: string) => resolveProxyChain({ provider: strategies[pid]?.proxyPoolId, global: settings?.globalProxyPoolId, pools });
  const resolveGlobal = () => resolveProxyChain({ global: settings?.globalProxyPoolId, pools });

  const systemLabel = settings?.outboundProxyEnabled && settings?.outboundProxyUrl ? "System proxy" : "No proxy";
  const routeLabel = (r: ResolvedProxy) => {
    if (r.source === "direct") return "Direct";
    if (r.source === "legacy") return "Custom URL";
    if (r.layer === "system") return systemLabel;
    return r.proxyPool?.name || r.proxyPoolId || "Missing pool";
  };

  const providerIds = useMemo(
    () => [...new Set(connections.map((c) => c.provider))].sort((a, b) => providerName(a, connections).localeCompare(providerName(b, connections))),
    [connections],
  );

  const sel: Selection = selected || (connections[0] ? { type: "account", id: connections[0].id } : { type: "global" });
  const selAccount = sel?.type === "account" ? connections.find((c) => c.id === sel.id) || null : null;
  const selRoute = selAccount ? resolveAccount(selAccount) : null;

  // Accounts whose route the selected provider or Global layer decides.
  const governed = (s: Selection | null) => {
    if (!s || s.type === "account") return [];
    if (s.type === "global") return connections.filter((c) => LAYER_INDEX[resolveAccount(c).layer] === 2);
    return connections.filter((c) => c.provider === s.id && resolveAccount(c).layer === "provider");
  };
  const governedIds = new Set(governed(sel).map((c) => c.id));

  // Other accounts of the same provider leaving through the same proxy.
  const sharesWith = (c: Connection) => {
    const exit = proxyExit(resolveAccount(c));
    return exit ? connections.filter((o) => o.id !== c.id && o.provider === c.provider && proxyExit(resolveAccount(o)) === exit) : [];
  };

  const roleOf = (type: Selection["type"], id?: string): Role => {
    if (!sel) return "dim";
    if (sel.type === type && (type === "global" || ("id" in sel && sel.id === id))) return "selected";
    if (selAccount && selRoute) {
      const at = LAYER_INDEX[selRoute.layer];
      if (type === "provider" && id === selAccount.provider) return at === 1 ? "winner" : at > 1 ? "path" : "dim";
      if (type === "global") return at === 2 ? "winner" : "dim";
      return "dim";
    }
    if (type === "account" && id && governedIds.has(id)) return "path";
    if (type === "provider" && sel.type === "global" && id && !providerSetting(id)) return "path";
    return "dim";
  };

  // Remounting on this key replays the entry animations only when the route changes.
  const animKey = JSON.stringify([sel, settings?.globalProxyPoolId, strategies, connections.map((c) => [c.id, accountSetting(c)])]);

  function valueLine(own: string | null, route: ResolvedProxy) {
    const blocked = route.source === "blocked";
    if (own) {
      const icon = blocked ? "block" : own === PROXY_DIRECT ? "language" : "vpn_lock";
      return <Badge size="sm" variant={blocked ? "error" : "primary"} icon={icon} className="max-w-full truncate">{routeLabel(route)}</Badge>;
    }
    return (
      <span className={`inline-flex min-w-0 max-w-full items-center gap-1 text-[11px] ${blocked ? TONE.error : TONE.muted}`}>
        <span className="material-symbols-outlined shrink-0 text-[14px]">arrow_downward</span>
        <span className="truncate">{routeLabel(route)}</span>
      </span>
    );
  }

  function node(type: Selection["type"], id: string | undefined, step: number, children: ReactNode) {
    const role = roleOf(type, id);
    const fx = role === "dim" ? "px-dim" : "px-pop";
    return (
      <button
        key={`${type}:${id || ""}`}
        type="button"
        onClick={() => { setSelected(type === "global" ? { type } : { type, id: id! } as Selection); setTest(null); }}
        style={delay(step * STEP_MS)}
        className={`${fx} block w-full min-w-0 cursor-pointer rounded-[10px] border ${ROLE_CLASS[role]} p-2.5 text-left transition-colors hover:border-brand-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40`}
      >
        {children}
      </button>
    );
  }

  const arrow = (lit: boolean, step: number) => (
    <div className="flex justify-center py-1">
      <span className={`material-symbols-outlined text-[16px] ${lit ? "px-drip text-brand-500" : "text-text-muted/40"}`} style={lit ? delay(step * STEP_MS + STEP_MS / 2) : undefined}>arrow_downward</span>
    </div>
  );

  // ─── Saving ──────────────────────────────────────────────────────
  // Writes go through api.js, which throws on any non-2xx, so every failure reaches the user.
  async function save(run: () => Promise<unknown>) {
    setSaving(true);
    setTest(null);
    try {
      await run();
    } catch (error) {
      notify.error(error instanceof Error ? error.message : "Failed to update proxy");
    } finally {
      await Promise.all([load(), onPoolsChanged()]);
      setSaving(false);
    }
  }

  const saveAccount = (c: Connection, value: string) => save(() => api.put(`/api/providers/${c.id}`, {
    // Picking anything replaces a legacy per-account URL.
    proxyPoolId: value === INHERIT ? null : value, ...(hasLegacy(c) ? { connectionProxyEnabled: false, connectionProxyUrl: "" } : {}),
  }));

  const saveProvider = (pid: string, value: string) => save(async () => {
    // A failed read throws, so no PATCH replaces the map without every other provider's entry.
    const current = ((await api.get("/api/settings", { cache: "no-store" })) as Settings).providerStrategies || {};
    const override = { ...(current[pid] || {}) };
    if (value === INHERIT) delete override.proxyPoolId;
    else override.proxyPoolId = value;
    const updated = { ...current };
    if (Object.keys(override).length === 0) delete updated[pid];
    else updated[pid] = override;
    return api.patch("/api/settings", { providerStrategies: updated });
  });

  const saveGlobal = (value: string) => save(() => api.patch("/api/settings", { globalProxyPoolId: value === INHERIT ? null : value }));

  const makeStrict = (poolId: string) => save(() => api.put(`/api/proxy-pools/${poolId}`, { strictProxy: true }));

  async function runTest(c: Connection) {
    const run = ++testRun.current;
    setTest({ id: c.id, run, status: "running" });
    try {
      const res = await fetch(`/api/providers/${c.id}/test`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      const ms = Number.isFinite(data.latencyMs) && data.latencyMs > 0 ? ` in ${data.latencyMs} ms` : "";
      const result: TestState = data.valid
        ? { id: c.id, run, status: "done", ok: true, text: `Works${ms}.${data.error ? ` ${data.error}` : ""}` }
        : { id: c.id, run, status: "done", ok: false, text: data.error || "Test failed" };
      setTest((cur) => (cur?.run === run ? result : cur));
    } catch (error) {
      const text = error instanceof Error ? error.message : "Test failed";
      setTest((cur) => (cur?.run === run ? { id: c.id, run, status: "done", ok: false, text } : cur));
    }
  }

  // ─── Side panel ──────────────────────────────────────────────────
  const poolOptions = proxyPools.map((p) => ({ value: p.id, label: p.isActive === true ? p.name || p.id : `${p.name || p.id} (off)` }));
  const optionsFor = (inheritLabel: string | null, legacy = false) => [
    ...(inheritLabel ? [{ value: INHERIT, label: `Inherit (${inheritLabel})` }] : [{ value: INHERIT, label: `System default (${systemLabel})` }]),
    { value: PROXY_DIRECT, label: "Direct (no proxy)" },
    ...poolOptions,
    ...(legacy ? [{ value: LEGACY, label: "Custom URL (legacy)" }] : []),
  ];

  function routePanel(account: Connection, route: ResolvedProxy) {
    const test = testState?.id === account.id ? testState : null;
    const done = test?.status === "done" ? test : null;
    const chipFx = (n: number): { cls: string; style?: CSSProperties } => {
      if (test?.status === "running") return { cls: "px-hop", style: delay(n * 250) };
      if (done && !done.ok && n === 1) return { cls: "px-shake" };
      if (done?.ok && n === 2) return { cls: "px-land" };
      if (!test) return { cls: "px-chip", style: delay(2 * STEP_MS + n * 90) };
      return { cls: "" };
    };
    const chip = (n: number, icon: string, children: ReactNode) => {
      const fx = chipFx(n);
      return (
        <span style={fx.style} className={`${fx.cls} inline-flex min-w-0 items-center gap-1.5 rounded-[8px] bg-surface-2 px-2 py-1 text-xs font-medium text-text-main`}>
          <span className="material-symbols-outlined text-[16px] text-text-muted">{icon}</span>
          <span className="truncate">{children}</span>
        </span>
      );
    };
    const sep = <span className="material-symbols-outlined text-[16px] text-text-muted">arrow_forward</span>;
    const blocked = route.source === "blocked";
    const usesProxy = route.connectionProxyEnabled || !!route.vercelRelayUrl;
    const url = maskProxyUrl(route.connectionProxyUrl || route.vercelRelayUrl);

    const shared = sharesWith(account);
    const sharedNote = shared.length > 0 && (
      <Note icon="warning" tone={TONE.warn}>
        Same proxy as <span className={blurClass}>{shared.map(accountName).join(", ")}</span>, so these {providerName(account.provider, connections)} accounts reach it from one IP.
      </Note>
    );

    let mode: ReactNode;
    if (blocked) mode = <Note icon="block" tone={TONE.error}>{route.blockedReason}, so requests from this account are blocked instead of going direct.</Note>;
    else if (route.source === "direct") mode = <Note icon="language" tone={TONE.muted}>Sent from this machine&apos;s IP.</Note>;
    else if (route.layer === "system") mode = <Note icon="language" tone={TONE.muted}>{settings?.outboundProxyEnabled && settings?.outboundProxyUrl ? "Uses the outbound proxy from Settings." : "No proxy is set anywhere, so requests leave from this machine's IP."}</Note>;
    // A relay only rewrites the request to its own URL, so it can't fall back to direct.
    else if (route.vercelRelayUrl) mode = <Note icon="lock" tone={TONE.ok}>Fails closed. If the relay is down, the request errors.</Note>;
    else if (route.strictProxy) mode = <Note icon="lock" tone={TONE.ok}>Fails closed. If the proxy is down, the request errors instead of going direct.</Note>;
    else mode = (
      <div className="flex flex-col gap-2">
        <Note icon="warning" tone={TONE.warn}>Falls back to direct if the proxy is down, which exposes this machine&apos;s IP.</Note>
        {route.proxyPoolId && <div><Button size="sm" variant="secondary" icon="lock" disabled={saving} onClick={() => makeStrict(route.proxyPoolId!)}>Make strict</Button></div>}
      </div>
    );

    return (
      <>
        <p className="text-xs text-text-muted">Set by the <span className="font-semibold text-text-main">{route.layer === "system" ? "global" : route.layer}</span> layer</p>
        <div className="flex flex-wrap items-center gap-1.5">
          {chip(0, "person", <span className={blurClass}>{accountName(account)}</span>)}{sep}
          {chip(1, blocked ? "block" : usesProxy ? "vpn_lock" : "language", routeLabel(route))}{sep}
          {chip(2, "cloud", providerName(account.provider, connections))}
        </div>
        {url && <p className="truncate font-mono text-[11px] text-text-muted">{url}</p>}
        <div className="flex flex-col gap-2">{mode}{sharedNote}</div>
        <div className="border-t border-border-subtle pt-3">
          <Button size="sm" variant="secondary" icon="send" loading={test?.status === "running"} onClick={() => runTest(account)}>Send test request</Button>
          {done && <div className="fade-in mt-3"><Note icon={done.ok ? "check_circle" : "error"} tone={done.ok ? TONE.ok : TONE.error}>{done.text}</Note></div>}
        </div>
      </>
    );
  }

  function oneEachPanel(pid: string, accounts: Connection[]) {
    if (accounts.length < 2) return null;
    const exits = accounts.map((c) => proxyExit(resolveAccount(c)));
    const distinct = new Set(exits.filter(Boolean)).size;
    const allOwn = distinct === accounts.length;
    const plan = oneEachAssignments(accounts.map((c) => c.id), proxyPools);
    const usable = oneEachPools(proxyPools).length;
    return (
      <div className="flex flex-col gap-2 rounded-[8px] bg-surface-2 p-2.5">
        <p className={`flex items-center gap-1.5 text-xs ${allOwn ? TONE.ok : TONE.muted}`}>
          <span className="material-symbols-outlined text-[16px]">{allOwn ? "check_circle" : "call_split"}</span>
          {accounts.length} accounts · {distinct} separate prox{distinct === 1 ? "y" : "ies"}
        </p>
        {!allOwn && (plan
          ? <div><Button size="sm" variant="secondary" icon="call_split" disabled={saving} onClick={() => setConfirmOneEach(pid)}>Give each its own pool</Button></div>
          : <p className="text-[11px] text-text-muted">One proxy each needs {accounts.length} active pools; there {usable === 1 ? "is" : "are"} {usable}.</p>)}
      </div>
    );
  }

  async function applyOneEach(pid: string) {
    const accounts = connections.filter((c) => c.provider === pid);
    const plan = oneEachAssignments(accounts.map((c) => c.id), proxyPools);
    setConfirmOneEach(null);
    if (!plan) return;
    setSaving(true);
    setTest(null);
    let failed = 0;
    for (const { id, poolId } of plan) {
      try {
        await api.put(`/api/providers/${id}`, { proxyPoolId: poolId, connectionProxyEnabled: false, connectionProxyUrl: "" });
      } catch {
        failed += 1;
      }
    }
    if (failed) notify.error(`${failed} of ${plan.length} accounts couldn't be updated`);
    else notify.success(`Each ${providerName(pid, connections)} account now has its own pool`);
    await Promise.all([load(), onPoolsChanged()]);
    setSaving(false);
  }

  function reachPanel(s: Selection) {
    const decided = governed(s);
    const scope = s.type === "global" ? connections : connections.filter((c) => s.type === "provider" && c.provider === s.id);
    // Of the rest: accounts with a setting of their own, and the ones another layer
    // decides — Global for a provider's panel, their provider for Global's.
    const own = scope.filter((c) => !decided.includes(c) && resolveAccount(c).layer === "account");
    const below = scope.filter((c) => !decided.includes(c) && !own.includes(c));
    const row = (c: Connection) => (
      <li key={c.id} className="flex items-center justify-between gap-2 py-1.5 text-xs">
        <span className="flex min-w-0 items-center gap-2">
          <ProviderIcon providerId={c.provider} size={16} className="shrink-0 rounded-[4px]" />
          <span className={`truncate text-text-main ${blurClass}`}>{accountName(c)}</span>
        </span>
        <span className="shrink-0 text-text-muted">{routeLabel(resolveAccount(c))}</span>
      </li>
    );
    return (
      <>
        <p className="text-xs text-text-muted">
          Decides the route for <span className="font-semibold text-text-main">{decided.length} of {scope.length}</span> account{scope.length === 1 ? "" : "s"}.
        </p>
        {s.type === "provider" && oneEachPanel(s.id, scope)}
        {decided.length > 0 && <ul className="max-h-48 divide-y divide-border-subtle overflow-y-auto">{decided.map(row)}</ul>}
        {own.length > 0 && (
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Set their own</p>
            <ul className="max-h-40 divide-y divide-border-subtle overflow-y-auto opacity-70">{own.map(row)}</ul>
          </div>
        )}
        {below.length > 0 && (
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">{s.type === "global" ? "Set by their provider" : "Use Global"}</p>
            <ul className="max-h-40 divide-y divide-border-subtle overflow-y-auto opacity-70">{below.map(row)}</ul>
          </div>
        )}
        <p className="text-xs text-text-muted">Click an account to send a test request.</p>
      </>
    );
  }

  function sidePanel(s: Selection) {
    let kind: string, title: ReactNode, icon: ReactNode, control: ReactNode;
    if (s.type === "account" && selAccount) {
      kind = "Account";
      title = <span className={blurClass}>{accountName(selAccount)}</span>;
      icon = <ProviderIcon providerId={selAccount.provider} size={20} className="rounded-[4px]" />;
      const value = accountSetting(selAccount) || INHERIT;
      control = <Select aria-label="Account proxy" placeholder="Choose a proxy" disabled={saving} value={value}
        options={optionsFor(routeLabel(resolveProvider(selAccount.provider)), value === LEGACY)}
        onChange={(e) => e.target.value !== LEGACY && saveAccount(selAccount, e.target.value)} />;
    } else if (s.type === "provider") {
      kind = "Provider";
      title = `Every ${providerName(s.id, connections)} account`;
      icon = <ProviderIcon providerId={s.id} size={20} className="rounded-[4px]" />;
      control = <Select aria-label="Provider proxy" placeholder="Choose a proxy" disabled={saving} value={providerSetting(s.id) || INHERIT}
        options={optionsFor(routeLabel(resolveGlobal()))}
        onChange={(e) => saveProvider(s.id, e.target.value)} />;
    } else {
      kind = "Global";
      title = "All providers and accounts";
      icon = <span className="material-symbols-outlined text-[20px] text-text-muted">public</span>;
      control = <Select aria-label="Global proxy" placeholder="Choose a proxy" disabled={saving} value={globalSetting || INHERIT}
        options={optionsFor(null)}
        onChange={(e) => saveGlobal(e.target.value)} />;
    }
    return (
      <div className="fade-in flex flex-col gap-3 self-start rounded-[10px] border border-border-subtle bg-bg p-4 lg:sticky lg:top-4">
        <div className="flex items-center gap-3">
          <div className="rounded-[10px] bg-surface p-2">{icon}</div>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">{kind}</p>
            <p className="truncate text-sm font-medium text-text-main">{title}</p>
          </div>
        </div>
        {control}
        {s.type === "account" && selAccount && selRoute ? routePanel(selAccount, selRoute) : reachPanel(s)}
      </div>
    );
  }

  // Routes resolve against the pools, so nothing is drawn (or editable) before they,
  // the settings and the accounts have loaded: an empty pool list would paint every
  // bound account as blocked, and a save could write over values that never arrived.
  const failure = loadError || (!poolsLoaded && poolsError);
  const ready = !!settings && poolsLoaded && !loadError;
  if (!settings || !poolsLoaded) {
    return failure ? (
      <Card title="Proxy routing" icon="layers">
        <Note icon="error" tone={TONE.error} alert>Couldn&apos;t load proxy routing: {failure}</Note>
      </Card>
    ) : null;
  }

  return (
    <Card title="Proxy routing" subtitle="Accounts inherit from their provider, and providers from Global. Click any block to change it." icon="layers">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div key={animKey}>
          <div className="mb-1 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wide text-text-muted">
            <span>Accounts</span><span>Most specific wins</span>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-x-3 gap-y-4">
            {providerIds.map((pid) => {
              const accs = connections.filter((c) => c.provider === pid);
              const shown = expanded[pid] ? accs : accs.slice(0, MAX_ACCOUNTS);
              const upLit = (selAccount?.provider === pid && !!selRoute && LAYER_INDEX[selRoute.layer] >= 1) || accs.some((c) => governedIds.has(c.id));
              const downLit = (selAccount?.provider === pid && !!selRoute && LAYER_INDEX[selRoute.layer] === 2) || (sel.type === "global" && !providerSetting(pid));
              return (
                <div key={pid} className="flex min-w-0 flex-col">
                  <div className="flex flex-1 flex-col justify-end gap-2">
                    {shown.map((c) => node("account", c.id, 0, <>
                      <p className={`truncate text-xs font-medium text-text-main ${blurClass}`}>{accountName(c)}</p>
                      <div className="mt-1 flex h-5 min-w-0 items-center gap-1">
                        {valueLine(accountSetting(c), resolveAccount(c))}
                        {sharesWith(c).length > 0 && (
                          <span className={`material-symbols-outlined shrink-0 text-[14px] ${TONE.warn}`} title={`Shares its proxy with ${sharesWith(c).length} other ${providerName(c.provider, connections)} account${sharesWith(c).length === 1 ? "" : "s"}`}>warning</span>
                        )}
                      </div>
                    </>))}
                    {accs.length > MAX_ACCOUNTS && (
                      <button type="button" onClick={() => setExpanded((e) => ({ ...e, [pid]: !e[pid] }))} className="text-left text-[11px] text-text-muted hover:text-text-main">
                        {expanded[pid] ? "Show fewer" : `+${accs.length - MAX_ACCOUNTS} more`}
                      </button>
                    )}
                  </div>
                  {arrow(upLit, 0)}
                  {node("provider", pid, 1, <>
                    <div className="flex min-w-0 items-center gap-2">
                      <ProviderIcon providerId={pid} size={16} className="shrink-0 rounded-[4px]" />
                      <p className="truncate text-xs font-semibold text-text-main">{providerName(pid, connections)}</p>
                    </div>
                    <div className="mt-1 flex h-5 min-w-0 items-center">{valueLine(providerSetting(pid), resolveProvider(pid))}</div>
                  </>)}
                  {arrow(downLit, 1)}
                </div>
              );
            })}
          </div>
          {node("global", undefined, 2, (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="material-symbols-outlined text-[18px] text-text-muted">public</span>
                <p className="text-xs font-semibold text-text-main">Global</p>
                <span className="text-[11px] text-text-muted">All providers and accounts</span>
              </div>
              {valueLine(globalSetting, resolveGlobal())}
            </div>
          ))}
        </div>
        {ready ? sidePanel(sel) : (
          <div className="self-start rounded-[10px] border border-border-subtle bg-bg p-4">
            <Note icon="error" tone={TONE.error} alert>
              Couldn&apos;t load proxy routing: {loadError}
            </Note>
          </div>
        )}
      </div>
      <ConfirmModal
        isOpen={!!confirmOneEach}
        onClose={() => setConfirmOneEach(null)}
        onConfirm={() => confirmOneEach && applyOneEach(confirmOneEach)}
        title="Give each account its own pool?"
        message={confirmOneEach ? `Every ${providerName(confirmOneEach, connections)} account gets a different active pool, replacing what each account has set now.` : ""}
        confirmText="Assign pools"
        variant="primary"
        loading={saving}
      />
    </Card>
  );
}
