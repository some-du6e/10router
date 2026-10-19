"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import Input from "@/shared/components/Input";
import Select from "@/shared/components/Select";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { useBlurEmails } from "@/shared/hooks/useBlurEmails";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import QuotaTable from "./QuotaTable";
import SubscriptionValueBadge from "./SubscriptionValueBadge";
import useQuotaDashboard from "./useQuotaDashboard";
import {
  AccountLimits,
  Icon,
  ProviderWindow,
  QuotaDialog,
  quotaTone,
} from "./QuotaDashboardParts";
import {
  buildAccount,
  compareAccounts,
  compareBarAccounts,
  providerWindows,
  resetLabel,
  resetShort,
  resetTimestamp,
  updatedLabel,
} from "./dashboardModel";
import {
  filterQuotasByVisibility,
  getHiddenQuotaRows,
  getQuotaVisibilityKey,
  readSubValueWindow,
  writeSubValueWindow,
  ACCOUNT_PAGE_SIZE_OPTIONS,
  ACCOUNT_PAGE_SIZE_MAX,
} from "./utils";

const LEDGER =
  "grid grid-cols-2 gap-x-4 md:grid-cols-[minmax(160px,1.4fr)_minmax(65px,.6fr)_minmax(110px,1fr)_90px_80px]";
const STATUSES = ["Healthy", "Low quota", "Depleted", "Unknown", "Turned off"];
const PROVIDER_NAMES = {
  claude: "Claude",
  codex: "Codex",
  xai: "xAI",
  kimi: "Kimi",
};
const reducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const providerName = (id) => PROVIDER_NAMES[id] || AI_PROVIDERS[id]?.name || id;
const statusTone = (account) =>
  account.isActive === false
    ? quotaTone(null)
    : quotaTone(account.worstRemaining);

export default function ProviderLimits() {
  const data = useQuotaDashboard();
  const { blurClass, isBlurred } = useBlurEmails();
  const { copied, copy } = useCopyToClipboard();
  const [provider, setProvider] = useState("all");
  const [query, setQuery] = useState("");
  const [health, setHealth] = useState("all");
  const [sort, setSort] = useState("provider");
  const [view, setView] = useState("ledger");
  const [detailId, setDetailId] = useState(null);
  const [help, setHelp] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [customSize, setCustomSize] = useState("20");
  const [quotaVisibility, setQuotaVisibility] = useState({});
  const [visibilityBusy, setVisibilityBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [connectionValues, setConnectionValues] = useState({});
  const [valueWindow, setValueWindow] = useState(readSubValueWindow);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/settings", { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((settings) => {
        if (settings) setQuotaVisibility(settings.quotaVisibility || {});
      })
      .catch(() => {});
    fetch("/api/usage/connection-value", { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((values) => {
        if (values) setConnectionValues(values.connections || {});
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const accounts = useMemo(
    () =>
      data.connections.map((connection) =>
        buildAccount(
          connection,
          data.quotaData[connection.id],
          data.errors[connection.id],
        ),
      ),
    [data.connections, data.quotaData, data.errors],
  );
  const groups = useMemo(() => {
    const result = new Map();
    for (const account of accounts) {
      if (!result.has(account.provider)) result.set(account.provider, []);
      result.get(account.provider).push(account);
    }
    return [...result].map(([id, group]) => ({
      id,
      name: providerName(id),
      accounts: group.sort(compareBarAccounts),
    }));
  }, [accounts]);
  const rows = useMemo(
    () =>
      accounts
        .filter(
          (account) =>
            (provider === "all" || account.provider === provider) &&
            (health === "all" ||
              account.status === health ||
              (health === "active" && account.isActive !== false)) &&
            `${account.name} ${account.email || ""} ${account.displayName || ""} ${providerName(account.provider)} ${account.plan}`
              .toLowerCase()
              .includes(query.trim().toLowerCase()),
        )
        .sort((a, b) => compareAccounts(a, b, sort)),
    [accounts, provider, health, query, sort],
  );
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageRows = rows.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );
  const visibleGroups = groups.filter(
    (group) => provider === "all" || group.id === provider,
  );
  const detail = accounts.find((account) => account.id === detailId);
  const updatedAt = accounts.reduce(
    (latest, account) =>
      account.updatedAt && (!latest || account.updatedAt > latest)
        ? account.updatedAt
        : latest,
    null,
  );
  const depletedGroups = visibleGroups
    .map((group) => ({
      ...group,
      depleted: group.accounts.filter((a) => a.status === "Depleted"),
    }))
    .filter((group) => group.depleted.length);

  // Tab changes slide the summary card like a deck: the old card exits as the
  // new one enters, and the deck eases between their heights. The ledger stays still.
  const deck = useRef(null);
  const tabs = useRef(null);
  const incoming = useRef(null);
  const outgoing = useRef(null);
  const lastTab = useRef(provider);
  const [leaving, setLeaving] = useState(null);
  useLayoutEffect(() => {
    const tabs = ["all", ...groups.map((group) => group.id)];
    const from = tabs.indexOf(lastTab.current);
    const to = tabs.indexOf(provider);
    const previous = lastTab.current;
    lastTab.current = provider;
    if (from === to || from < 0 || reducedMotion()) return;
    setLeaving({ id: previous, dir: to > from ? 1 : -1, key: performance.now() });
  }, [provider]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (!leaving) return;
    const shift = (n) => `translateX(calc(${n * 100}% + ${n * 24}px))`;
    const timing = { duration: 420, easing: "cubic-bezier(.65,0,.35,1)" };
    const fromHeight = outgoing.current?.offsetHeight;
    const toHeight = incoming.current?.offsetHeight;
    if (fromHeight && toHeight && fromHeight !== toHeight)
      deck.current?.animate(
        [{ height: `${fromHeight}px` }, { height: `${toHeight}px` }],
        timing,
      );
    incoming.current?.animate(
      [{ transform: shift(leaving.dir) }, { transform: "none" }],
      timing,
    );
    const exit = outgoing.current?.animate(
      [{ transform: "none" }, { transform: shift(-leaving.dir) }],
      { ...timing, fill: "forwards" },
    );
    const done = () =>
      setLeaving((current) => (current === leaving ? null : current));
    if (!exit) return done();
    exit.onfinish = done;
    // Backstop: onfinish may never fire if the deck unmounts mid-slide.
    const timer = setTimeout(done, timing.duration + 200);
    return () => clearTimeout(timer);
  }, [leaving]);

  function openProvider(id, nextHealth = "all") {
    setProvider(id);
    setHealth(nextHealth);
    setQuery("");
    setPage(1);
  }

  async function setActive(targets, active) {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      // Keep bulk changes scoped to the accounts visible on the current page.
      for (const account of targets)
        await data.setAccountActive(account.id, active);
    } catch (error) {
      setActionError(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function changeVisibility(account, quota, hide) {
    if (visibilityBusy) return;
    const hidden = new Set(quotaVisibility[account.provider]?.hidden || []);
    if (hide) hidden.add(getQuotaVisibilityKey(quota));
    else hidden.delete(getQuotaVisibilityKey(quota));
    const next = {
      ...quotaVisibility,
      [account.provider]: {
        ...quotaVisibility[account.provider],
        hidden: [...hidden],
      },
    };
    setVisibilityBusy(true);
    setActionError(null);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quotaVisibility: next }),
      });
      if (!response.ok)
        throw new Error("Could not save quota visibility. Please retry.");
      setQuotaVisibility(next);
    } catch (error) {
      setActionError(error.message);
    } finally {
      setVisibilityBusy(false);
    }
  }

  function applyPageSize(value) {
    const parsed = Number.parseInt(value, 10);
    const next = Number.isFinite(parsed)
      ? Math.min(ACCOUNT_PAGE_SIZE_MAX, Math.max(1, parsed))
      : pageSize;
    setPageSize(next);
    setCustomSize(String(next));
    setPage(1);
  }

  function summaryCard(filter) {
    const shown = groups.filter(
      (group) => filter === "all" || group.id === filter,
    );
    return (
    <Card padding="none" className="overflow-hidden">
      <div
        className={`grid grid-cols-1 gap-px bg-border-subtle ${shown.length > 1 ? "sm:grid-cols-2 xl:grid-cols-4" : ""}`}
      >
        {shown.map((group) => {
          const windows = providerWindows(group.accounts);
          const disabled = group.accounts.filter(
            (a) => a.isActive === false,
          ).length;
          return (
            <section
              key={group.id}
              data-i18n-skip="true"
              data-provider-summary={group.id}
              className="flex min-w-0 flex-col bg-surface p-5"
            >
              <div className="flex items-center gap-2">
                <ProviderIcon
                  providerId={group.id}
                  alt=""
                  size={22}
                  className="rounded object-contain"
                />
                <h2 className="text-sm font-semibold">{group.name}</h2>
                <span className="ml-auto text-xs text-text-muted">
                  {group.accounts.length} account
                  {group.accounts.length === 1 ? "" : "s"}
                </span>
              </div>
              {windows.map((window, i) => (
                <ProviderWindow
                  key={window.key}
                  name={group.name}
                  accounts={group.accounts}
                  quotaWindow={window}
                  first={i === 0}
                  onSelect={setDetailId}
                  privateNames={isBlurred}
                  now={data.now}
                />
              ))}
              {!windows.length && (
                <div className="mt-5">
                  <p className="text-xs text-text-muted">
                    Provider limit
                  </p>
                  <p className="mt-1 text-3xl font-semibold">—</p>
                  <p className="mt-2 text-xs text-text-muted">
                    {group.accounts.some((a) => data.loading[a.id])
                      ? "Loading quotas..."
                      : "Quota not reported"}
                  </p>
                </div>
              )}
              {disabled > 0 && (
                <p className="mt-2 text-xs text-text-muted">
                  {disabled} turned off, excluded from totals
                </p>
              )}
              <div className="mt-auto flex justify-end pt-3">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    openProvider(group.id);
                    // The card remounts on tab change; keep focus on its tab.
                    tabs.current?.querySelector(`[data-tab="${group.id}"]`)?.focus();
                  }}
                >
                  View accounts
                </Button>
              </div>
            </section>
          );
        })}
      </div>
    </Card>
    );
  }

  if (data.initialLoading)
    return (
      <Card>
        <p role="status" className="py-12 text-center text-sm text-text-muted">
          Loading accounts...
        </p>
      </Card>
    );

  // Runtime translation remembers old DOM text, so live readings opt out below.
  return (
    <div className="min-w-0 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-text-muted">
          <span
            className={`size-2 rounded-full ${data.connectionError ? "bg-yellow-500" : "bg-green-500"}`}
          />
          <span data-i18n-skip="true">
            <strong className="font-medium text-text-main">
              {accounts.length} accounts
            </strong>{" "}
            across {groups.length} providers
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <span data-i18n-skip="true" className="border-r border-border pr-4 text-xs text-text-muted">
            {updatedLabel(updatedAt, data.now)}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={data.autoRefresh}
            onClick={() => data.toggleAutoRefresh(!data.autoRefresh)}
            className="flex cursor-pointer items-center gap-3 rounded text-sm font-medium focus-visible:outline-2 focus-visible:outline-primary"
          >
            <span>Auto-refresh</span>
            <span
              aria-hidden="true"
              className={`relative h-4 w-8 rounded-full transition-colors ${data.autoRefresh ? "bg-brand-500" : "bg-surface-3"}`}
            >
              <span
                className={`absolute left-0 top-0.5 size-3 rounded-full bg-white shadow-sm transition-transform ${data.autoRefresh ? "translate-x-4" : "translate-x-0.5"}`}
              />
            </span>
          </button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            icon="refresh"
            loading={data.refreshing}
            onClick={() => data.refreshAll(true)}
          >
            Refresh all
          </Button>
        </div>
      </div>

      {data.connectionError && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-[10px] border border-yellow-500/20 bg-yellow-500/5 p-4 text-sm"
        >
          <p data-i18n-skip="true">{data.connectionError}</p>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => data.refreshAll(true)}
            disabled={data.refreshing}
          >
            Retry
          </Button>
        </div>
      )}
      {actionError && (
        <p role="alert" data-i18n-skip="true" className="text-sm text-red-500">
          {actionError}
        </p>
      )}

      {!accounts.length && !data.connectionError ? (
        <Card padding="lg" className="text-center">
          <Icon className="text-4xl text-text-muted">cloud_off</Icon>
          <h2 className="mt-4 text-lg font-semibold">No providers connected</h2>
          <p className="mt-2 text-sm text-text-muted">
            Connect a supported account to track its quota here.
          </p>
          <Link
            className="mt-4 inline-block text-sm text-primary"
            href="/dashboard/providers"
          >
            Connect a provider
          </Link>
        </Card>
      ) : (
        <>
          <div className="flex min-w-0 items-center justify-between gap-3 border-b border-border-subtle">
            <div
              ref={tabs}
              className="flex min-w-0 gap-4 overflow-x-auto scroll-thin-x"
              role="group"
              aria-label="Provider filters"
            >
              {[{ id: "all", name: "All", accounts }, ...groups].map(
                (group) => (
                  <button
                    type="button"
                    key={group.id}
                    data-tab={group.id}
                    onClick={() => openProvider(group.id)}
                    aria-pressed={provider === group.id}
                    className={`flex shrink-0 items-center gap-2 border-b-2 px-1 pb-3 text-sm font-medium transition-colors ${provider === group.id ? "border-primary text-primary" : "border-transparent text-text-muted hover:text-text-main"}`}
                  >
                    {group.id === "all" ? (
                      <Icon>apps</Icon>
                    ) : (
                      <ProviderIcon
                        providerId={group.id}
                        alt=""
                        size={18}
                        className="rounded object-contain"
                      />
                    )}
                    {group.name}
                    <span data-i18n-skip="true" className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-muted">
                      {group.accounts.length}
                    </span>
                  </button>
                ),
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              icon="help"
              aria-label="Explain quota bars"
              onClick={() => setHelp(true)}
            />
          </div>

          <div ref={deck} className="relative overflow-clip">
            <div ref={incoming} key={provider}>
              {summaryCard(provider)}
            </div>
            {leaving && (
              <div
                ref={outgoing}
                key={leaving.key}
                aria-hidden="true"
                inert
                className="pointer-events-none absolute inset-x-0 top-0"
              >
                {summaryCard(leaving.id)}
              </div>
            )}
          </div>
          <div className="flex flex-wrap justify-between gap-3 text-xs text-text-muted">
            <span>
              Remaining quota. Fullest on the left, blocked accounts on the
              right.
            </span>
            <div className="flex flex-wrap gap-4">
              {STATUSES.slice(0, 4).map((status, i) => (
                <span key={status} className="flex items-center gap-1.5">
                  <i
                    className={`size-1.5 rounded-full ${["bg-green-500", "bg-yellow-500", "bg-red-500", "bg-text-muted"][i]}`}
                  />
                  {status}
                </span>
              ))}
            </div>
          </div>

          {depletedGroups.map((group) => {
            const times = group.depleted
              .map((a) => resetTimestamp(a.worstWindow))
              .filter(Number.isFinite);
            return (
              <div
                key={group.id}
                className="flex items-center gap-3 rounded-[10px] border border-yellow-500/20 bg-yellow-500/5 px-4 py-3"
              >
                <Icon className="text-yellow-600 dark:text-yellow-500">
                  warning
                </Icon>
                <p data-i18n-skip="true" className="flex-1 text-xs text-text-muted">
                  <strong className="font-medium text-text-main">
                    {group.depleted.length} {group.name} account
                    {group.depleted.length === 1 ? " is" : "s are"} depleted.
                  </strong>
                  {times.length > 0 &&
                    ` Next ${resetLabel(
                      { resetAt: Math.min(...times) },
                      data.now,
                    )
                      .replace(/^Resets/, "Reset")
                      .toLowerCase()}.`}
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => openProvider(group.id, "Depleted")}
                >
                  View
                </Button>
              </div>
            );
          })}

          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">
                Accounts{" "}
                <span data-i18n-skip="true" className="ml-1 text-sm font-normal text-text-muted">
                  {rows.length}
                </span>
              </h2>
              <div className="flex gap-1 rounded-[10px] bg-surface-2 p-1">
                {["ledger", "cards"].map((mode) => (
                  <Button
                    key={mode}
                    variant={view === mode ? "secondary" : "ghost"}
                    size="sm"
                    icon={mode === "ledger" ? "view_list" : "grid_view"}
                    aria-pressed={view === mode}
                    onClick={() => setView(mode)}
                  >
                    {mode === "ledger" ? "Ledger" : "Cards"}
                  </Button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap gap-3">
              <Input
                aria-label="Search accounts"
                icon="search"
                placeholder="Search accounts..."
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(1);
                }}
                className="min-w-0 flex-1 basis-52"
              />
              <Select
                aria-label="Filter by status"
                value={health}
                onChange={(e) => {
                  setHealth(e.target.value);
                  setPage(1);
                }}
                options={[
                  { value: "all", label: "All statuses" },
                  { value: "active", label: "Active accounts" },
                  ...STATUSES.map((s) => ({ value: s, label: s })),
                ]}
              />
              <Select
                aria-label="Sort accounts"
                value={sort}
                onChange={(e) => {
                  setSort(e.target.value);
                  setPage(1);
                }}
                options={[
                  { value: "provider", label: "Provider, then lowest" },
                  { value: "remaining", label: "Lowest remaining" },
                  { value: "remaining-desc", label: "Highest remaining" },
                  { value: "reset", label: "Next reset" },
                ]}
              />
              {(query || health !== "all" || provider !== "all") && (
                <Button variant="ghost" onClick={() => openProvider("all")}>
                  Clear
                </Button>
              )}
            </div>
            <Card
              padding="none"
              className={
                view === "ledger"
                  ? "overflow-hidden"
                  : "border-0 bg-transparent shadow-none"
              }
            >
              {view === "ledger" && (
                <div
                  className={`${LEDGER} hidden border-b border-border-subtle bg-surface-2/50 px-5 py-3 text-xs font-medium text-text-muted md:grid`}
                >
                  <span>Account</span>
                  <span>Plan</span>
                  <span>Remaining</span>
                  <span>Next reset</span>
                  <span>Status</span>
                </div>
              )}
              <div
                className={
                  view === "cards"
                    ? "grid gap-4 md:grid-cols-2 xl:grid-cols-3"
                    : ""
                }
              >
                {pageRows.map((account) => (
                  <button
                    type="button"
                    key={account.id}
                    data-account={account.id}
                    data-i18n-skip="true"
                    onClick={() => {
                      setActionError(null);
                      setDetailId(account.id);
                    }}
                    className={`${view === "cards" ? "grid gap-4 rounded-[14px] border border-border-subtle bg-surface p-5 text-left hover:border-primary/30" : `${LEDGER} w-full items-center gap-y-3 border-b border-border-subtle px-5 py-3 text-left transition-colors last:border-0 hover:bg-surface-2/50`} ${account.isActive === false ? "opacity-60" : ""}`}
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <ProviderIcon
                        providerId={account.provider}
                        alt=""
                        size={28}
                        className="shrink-0 rounded object-contain"
                      />
                      <span className="block min-w-0">
                        <span
                          className={`block truncate text-sm font-medium ${account.name === account.email ? blurClass : ""}`}
                        >
                          {providerName(account.provider)} / {account.name}
                        </span>
                        {account.email && account.email !== account.name && (
                          <span
                            className={`block mt-1 truncate text-xs text-text-muted ${blurClass}`}
                          >
                            {account.email}
                          </span>
                        )}
                        <span className="block mt-1 text-[10px] text-text-muted md:hidden">
                          {account.plan}
                        </span>
                        {account.error && (
                          <span className="block mt-1 text-[10px] text-yellow-600 dark:text-yellow-500">
                            Refresh failed.{" "}
                            {updatedLabel(account.updatedAt, data.now)}.
                          </span>
                        )}
                        {data.loading[account.id] && (
                          <span className="block mt-1 text-[10px] text-text-muted">
                            Refreshing...
                          </span>
                        )}
                      </span>
                    </span>
                    <span
                      className={
                        view === "cards"
                          ? "block text-xs"
                          : "hidden text-xs md:block"
                      }
                    >
                      {account.plan}
                    </span>
                    <AccountLimits
                      account={account}
                      now={data.now}
                      compact={view === "ledger"}
                    />
                    <span
                      className="whitespace-nowrap text-xs text-text-muted"
                      title={(account.worstWindow || account.priority)?.label}
                    >
                      {resetShort(
                        account.worstWindow || account.priority,
                        data.now,
                      ) ?? "—"}
                    </span>
                    <span
                      className={`flex items-center gap-1.5 text-xs ${statusTone(account).text}`}
                    >
                      <i
                        className={`size-1.5 shrink-0 rounded-full ${statusTone(account).bar}`}
                      />
                      {account.status}
                    </span>
                  </button>
                ))}
              </div>
              {!rows.length && (
                <p className="p-8 text-center text-sm text-text-muted">
                  No accounts match your filters.
                </p>
              )}
            </Card>
            <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-text-muted">
              <span data-i18n-skip="true">
                Showing {rows.length ? (currentPage - 1) * pageSize + 1 : 0}-
                {Math.min(currentPage * pageSize, rows.length)} of {rows.length}{" "}
                accounts
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  aria-label="Accounts per page"
                  value={
                    ACCOUNT_PAGE_SIZE_OPTIONS.includes(pageSize)
                      ? String(pageSize)
                      : "custom"
                  }
                  onChange={(e) => {
                    if (e.target.value !== "custom")
                      applyPageSize(e.target.value);
                  }}
                  className="rounded-lg bg-surface-2 px-2 py-1.5 text-text-main"
                >
                  {ACCOUNT_PAGE_SIZE_OPTIONS.map((size) => (
                    <option key={size} value={size}>
                      {size} / page
                    </option>
                  ))}
                  <option value="custom">Custom</option>
                </select>
                <input
                  aria-label="Custom accounts per page"
                  type="number"
                  min="1"
                  max={ACCOUNT_PAGE_SIZE_MAX}
                  value={customSize}
                  onChange={(e) => setCustomSize(e.target.value)}
                  onBlur={() => applyPageSize(customSize)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") applyPageSize(customSize);
                  }}
                  className="w-16 rounded-lg bg-surface-2 px-2 py-1.5 text-text-main"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Previous accounts page"
                  disabled={currentPage === 1}
                  onClick={() => setPage(currentPage - 1)}
                  icon="chevron_left"
                />
                <span data-i18n-skip="true">
                  Page {currentPage} / {totalPages}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Next accounts page"
                  disabled={currentPage === totalPages}
                  onClick={() => setPage(currentPage + 1)}
                  icon="chevron_right"
                />
              </div>
            </div>
            <details className="text-xs text-text-muted">
              <summary className="w-fit cursor-pointer">
                Account actions
              </summary>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <span>Current page only</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    busy ||
                    !pageRows.some((a) => a.status === "Depleted" && !a.error)
                  }
                  onClick={() =>
                    setActive(
                      pageRows.filter(
                        (a) => a.status === "Depleted" && !a.error,
                      ),
                      false,
                    )
                  }
                >
                  Turn off empty
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    busy ||
                    !pageRows.some(
                      (a) =>
                        a.isActive === false &&
                        ["Healthy", "Low quota"].includes(a.health) &&
                        !a.error,
                    )
                  }
                  onClick={() =>
                    setActive(
                      pageRows.filter(
                        (a) =>
                          a.isActive === false &&
                          ["Healthy", "Low quota"].includes(a.health) &&
                          !a.error,
                      ),
                      true,
                    )
                  }
                >
                  Turn on available
                </Button>
              </div>
            </details>
          </div>
        </>
      )}

      {detail && (
        <QuotaDialog
          title={<span className={detail.name === detail.email ? blurClass : ""}>{providerName(detail.provider)} / {detail.name}</span>}
          onClose={() => setDetailId(null)}
          footer={
            <>
              <Link
                href={`/dashboard/accounts/${detail.id}`}
                className="mr-auto text-sm text-primary"
              >
                Manage account
              </Link>
              <Button variant="secondary" onClick={() => setDetailId(null)}>
                Close
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            {detail.email && (
              <p className={`break-all text-sm text-text-muted ${blurClass}`}>
                {detail.email}
              </p>
            )}
            <div className="flex justify-between gap-3 border-b border-border-subtle pb-3 text-sm">
              <span className="text-text-muted">Plan</span>
              <span>{detail.plan}</span>
            </div>
            {connectionValues[detail.id] && (
              <SubscriptionValueBadge
                value={connectionValues[detail.id]}
                window={valueWindow}
                onToggleWindow={() => {
                  const next =
                    valueWindow === "lifetime" ? "month" : "lifetime";
                  setValueWindow(next);
                  writeSubValueWindow(next);
                }}
              />
            )}
            <AccountLimits account={detail} now={data.now} />
            {detail.weeklyBlocked && (
              <p className="text-xs text-red-500">
                Weekly exhausted. This account cannot be used until its weekly
                limit resets.
              </p>
            )}
            {detail.isActive === false && (
              <p className="text-xs text-text-muted">
                Turned off. Excluded from available totals.
              </p>
            )}
            <p className="text-xs text-text-muted">
              {updatedLabel(detail.updatedAt, data.now)}. Each quota window
              resets independently.
            </p>
            {detail.error && (
              <p
                role="alert"
                className="text-xs text-yellow-600 dark:text-yellow-500"
              >
                Refresh failed: {detail.error}
                {detail.updatedAt ? " Your last reading is shown above." : ""}
              </p>
            )}
            {detail.message && (
              <p className="text-xs text-text-muted">{detail.message}</p>
            )}
            {actionError && (
              <p role="alert" className="text-xs text-red-500">
                {actionError}
              </p>
            )}
            <div className="flex flex-wrap gap-3">
              <Button
                size="sm"
                variant="secondary"
                icon="refresh"
                loading={data.loading[detail.id]}
                onClick={() => data.refreshAccount(detail)}
              >
                {detail.error ? "Retry" : "Refresh quota"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setActive([detail], detail.isActive === false)}
              >
                {detail.isActive === false
                  ? "Turn on account"
                  : "Turn off account"}
              </Button>
            </div>
            <details className="border-t border-border-subtle pt-3">
              <summary className="cursor-pointer text-xs text-text-muted">
                All limits and visibility
              </summary>
              <p className="mt-3 text-xs text-text-muted">
                Hidden rows only affect this detailed table. Summary bars still
                include limits that can block an account.
              </p>
              <div
                className={`mt-3 ${visibilityBusy ? "pointer-events-none opacity-60" : ""}`}
              >
                <QuotaTable
                  quotas={filterQuotasByVisibility(
                    detail.provider,
                    data.quotaData[detail.id]?.quotas || [],
                    quotaVisibility,
                  )}
                  compact
                  onHideQuota={(quota) => changeVisibility(detail, quota, true)}
                />
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {getHiddenQuotaRows(
                  detail.provider,
                  data.quotaData[detail.id]?.quotas || [],
                  quotaVisibility,
                ).map((quota) => (
                  <Button
                    key={getQuotaVisibilityKey(quota)}
                    size="sm"
                    variant="ghost"
                    disabled={visibilityBusy}
                    onClick={() => changeVisibility(detail, quota, false)}
                  >
                    Show {quota.name}
                  </Button>
                ))}
              </div>
            </details>
            {detail.provider === "kiro" && (
              <div className="space-y-2 border-t border-border-subtle pt-3 text-xs text-text-muted">
                <p>
                  {detail.providerSpecificData?.authMethod || detail.authType}{" "}
                  {detail.providerSpecificData?.region || ""}
                </p>
                {detail.providerSpecificData?.profileArn && (
                  <button
                    type="button"
                    onClick={() =>
                      copy(detail.providerSpecificData.profileArn, detail.id)
                    }
                    className="flex w-full items-start gap-2 rounded border border-border-subtle p-2 text-left transition-colors hover:text-primary focus-visible:outline-2 focus-visible:outline-primary"
                  >
                    <span
                      aria-hidden="true"
                      className="material-symbols-outlined text-[14px]"
                    >
                      {copied === detail.id ? "check" : "content_copy"}
                    </span>
                    <span className="sr-only">
                      {copied === detail.id ? "Copied" : "Copy"} profile ARN:
                    </span>{" "}
                    <code className="break-all font-mono">
                      {detail.providerSpecificData.profileArn}
                    </code>
                  </button>
                )}
              </div>
            )}
          </div>
        </QuotaDialog>
      )}
      {help && (
        <QuotaDialog
          title="Reading quota bars"
          onClose={() => setHelp(false)}
          footer={
            <Button variant="secondary" onClick={() => setHelp(false)}>
              Close
            </Button>
          }
        >
          <div className="space-y-3 text-sm text-text-muted">
            <p>
              Each segment is one account. The same account stays in the same
              position in both bars. Fullest accounts are on the left, with
              blocked and turned-off accounts on the right.
            </p>
            <p>
              The 5-hour limit comes first while weekly quota remains. If weekly
              quota is exhausted, the weekly limit and its reset come first.
            </p>
            <p>
              The big number is the average remaining across accounts.
              Short-window quota blocked by an exhausted or unknown weekly limit
              counts as empty. Turned-off accounts and other unknown readings
              are left out. Blocked
              percentages stay visible but faded. Failed refreshes keep the last
              reading and show when it was updated.
            </p>
            <p>
              Plans have different allowances, so the average is not a shared
              token balance.
            </p>
            <p>
              Click any segment or account row for details and refresh controls.
              Display order does not change routing.
            </p>
          </div>
        </QuotaDialog>
      )}
    </div>
  );
}
