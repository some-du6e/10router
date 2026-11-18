"use client";

import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import {
  formatRemaining,
  resetLabel,
  resetShort,
  summarizeWindow,
} from "./dashboardModel";

export function Icon({ children, className = "" }) {
  return (
    <span
      aria-hidden="true"
      className={`material-symbols-outlined text-[18px] ${className}`}
    >
      {children}
    </span>
  );
}

export function quotaTone(remaining) {
  if (remaining == null)
    return { text: "text-text-muted", bar: "bg-text-muted" };
  if (remaining === 0) return { text: "text-red-500", bar: "bg-red-500" };
  if (remaining < 30)
    return {
      text: "text-yellow-600 dark:text-yellow-500",
      bar: "bg-yellow-500",
    };
  return { text: "text-green-600 dark:text-green-500", bar: "bg-green-500" };
}

// Compact rows put the reset beside the label to keep ledger rows short.
export function AccountLimits({ account, now, compact = false }) {
  if (!account.mainWindows.length)
    return (
      <span className="block text-xs text-text-muted">Quota not reported</span>
    );
  return (
    <span
      className={`block min-w-0 ${compact ? "space-y-2" : "space-y-3"}`}
      data-limits={account.id}
      data-i18n-skip="true"
    >
      {account.mainWindows.map((quota, index) => (
        <span key={quota.key} data-window={quota.key} className="block">
          <span className="flex justify-between gap-2 text-xs">
            <span
              className={
                index === 0 ? "font-medium text-text-main" : "text-text-muted"
              }
            >
              {quota.label}
              {compact && (
                <span className="font-normal text-text-muted">
                  {" "}
                  · {resetShort(quota, now) ?? "no reset"}
                </span>
              )}
            </span>
            <span
              className={`shrink-0 tabular-nums ${quotaTone(quota.remaining).text}`}
            >
              {quota.unlimited ? "Unlimited" : formatRemaining(quota.remaining)}
            </span>
          </span>
          <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-surface-3">
            <span
              className={`block h-full rounded-full ${quotaTone(quota.remaining).bar}`}
              style={{ width: `${quota.remaining ?? 0}%` }}
            />
          </span>
          {!compact && (
            <span className="mt-1 block text-[10px] text-text-muted">
              {resetLabel(quota, now)}
            </span>
          )}
        </span>
      ))}
    </span>
  );
}

export function ProviderWindow({
  name,
  accounts,
  quotaWindow,
  first,
  onSelect,
  privateNames = false,
  now,
}) {
  const summary = summarizeWindow(accounts, quotaWindow);
  return (
    <div
      data-i18n-skip="true"
      data-provider-window={quotaWindow.key}
      className={first ? "mt-5" : "mt-4 border-t border-border-subtle pt-4"}
    >
      <p className="text-xs text-text-muted">{quotaWindow.label}</p>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
        <strong
          className={
            first
              ? "text-3xl font-semibold tracking-tight tabular-nums"
              : "text-xl font-semibold tracking-tight tabular-nums"
          }
        >
          {summary.average === null
            ? "—"
            : `${Math.round(summary.average)}%`}
        </strong>
        <span className="text-xs text-text-muted">
          {summary.average === null
            ? "Not reported"
            : `${quotaWindow.kind === "session" ? "usable" : "remaining"}${summary.averaged ? " on average" : ""}`}
        </span>
      </div>
      <div
        className="mt-2 flex gap-1"
        role="group"
        aria-label={`${name} ${quotaWindow.label}`}
      >
        {summary.values.map(({ account, quota, blocked }) => {
          const remaining = quota?.remaining ?? null;
          const accountName = privateNames && account.name === account.email ? "Private account" : account.name;
          const label = `${accountName}: ${quotaWindow.label}, ${remaining === null ? "unknown quota" : `${formatRemaining(remaining)} remaining`}${blocked ? `, ${blocked.toLowerCase()}` : ""}`;
          return (
            <button
              type="button"
              key={account.id}
              data-segment={`${account.id}-${quotaWindow.key}`}
              aria-label={label}
              title={`${label}. ${resetLabel(quota, now)}`}
              onClick={() => onSelect(account.id)}
              className="relative flex h-5 min-w-0 flex-1 items-end pb-1 rounded focus-visible:outline-2 focus-visible:outline-primary"
            >
              {blocked && remaining !== null && (
                <span
                  aria-hidden="true"
                  className="absolute right-0 top-0 max-w-full truncate text-[9px] text-text-muted/50"
                >
                  {formatRemaining(remaining)}
                </span>
              )}
              <span
                className={`block h-1.5 w-full overflow-hidden rounded-full bg-surface-3 ${blocked ? "opacity-30" : ""}`}
              >
                <span
                  className={`block h-full rounded-full ${quotaTone(remaining).bar}`}
                  style={{ width: `${remaining ?? 0}%` }}
                />
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-1 text-xs text-text-muted">
        {summary.nextReset === null
          ? "No reset time available"
          : `Next ${resetLabel({ resetAt: summary.nextReset }, now)
              .replace(/^Resets/, "Reset")
              .toLowerCase()}`}
      </p>
      {summary.unknown > 0 && summary.total !== null && (
        <p className="mt-1 text-[10px] text-text-muted">
          {summary.unknown} unknown, excluded from average
        </p>
      )}
      {summary.stale > 0 && (
        <p className="mt-1 text-[10px] text-yellow-600 dark:text-yellow-500">
          Includes last readings. Refresh failed.
        </p>
      )}
    </div>
  );
}

// Native dialogs trap focus. Restore the trigger explicitly when React unmounts.
// fallbackFocus receives focus when the trigger is gone, e.g. a row filtered out
// after its account was turned off from the dialog.
export function QuotaDialog({ title, onClose, children, footer, fallbackFocus }) {
  const ref = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const trigger = document.activeElement;
    const fallback = fallbackFocus?.current;
    const previousOverflow = document.body.style.overflow;
    dialog.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (trigger?.isConnected) trigger.focus();
      else fallback?.querySelector("input")?.focus();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return createPortal(
    <dialog
      data-i18n-skip="true"
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = [...ref.current.querySelectorAll(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
        )].filter((element) => element.getClientRects().length > 0);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
      onClick={(event) => {
        if (event.target === ref.current) {
          const r = ref.current.getBoundingClientRect();
          if (
            event.clientX < r.left ||
            event.clientX > r.right ||
            event.clientY < r.top ||
            event.clientY > r.bottom
          )
            onClose();
        }
      }}
      className="fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-lg overflow-hidden rounded-[14px] border border-border-subtle bg-surface p-0 text-text-main shadow-xl backdrop:bg-black/50 backdrop:backdrop-blur-[2px]"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-5 py-3">
        <h2 id={titleId} className="min-w-0 break-words text-lg font-semibold">
          {title}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="shrink-0 rounded-[10px] p-1.5 text-text-muted hover:bg-surface-2"
        >
          <Icon>close</Icon>
        </button>
      </div>
      <div className="max-h-[calc(90dvh-160px)] overflow-y-auto p-6 custom-scrollbar">
        {children}
      </div>
      {footer && (
        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border-subtle p-6">
          {footer}
        </div>
      )}
    </dialog>,
    document.body,
  );
}
