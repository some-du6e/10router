"use client";

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { Modal, CardSkeleton } from "@/shared/components";
import ActivityChart from "../../accounts/[id]/ActivityChart";
import { fmtCount, fmtRelative } from "../../accounts/[id]/formatters";
import { fmtUsdExact, budgetTone } from "./keyFormat";

function Stat({ label, value, sub }) {
  return (
    <div className="rounded-lg bg-surface-2 px-3 py-2">
      <p className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-text-subtle">{label}</p>
      <p className="text-[17px] font-semibold tabular-nums tracking-tight">{value}</p>
      {sub && <p className="text-[11.5px] text-text-muted">{sub}</p>}
    </div>
  );
}

Stat.propTypes = { label: PropTypes.string.isRequired, value: PropTypes.node.isRequired, sub: PropTypes.node };

/**
 * One key's spend: totals against its budget, spend per day for 30 days,
 * spend by model and the latest requests. Mount it per key while open.
 */
export default function KeyUsageModal({ apiKey, onClose }) {
  const [usage, setUsage] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    fetch(`/api/keys/${apiKey.id}/usage`, { cache: "no-store" })
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || "Could not load usage");
        return data;
      })
      .then((data) => live && setUsage(data))
      .catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [apiKey.id]);

  const budget = usage?.budget;
  const fraction = budget?.budgetUsd ? budget.spentUsd / budget.budgetUsd : budget?.budgetUsd === 0 ? 1 : 0;
  const maxModel = Math.max(...(usage?.byModel || []).map((m) => m.cost), 0.0001);
  const spent30d = (usage?.daily || []).reduce((sum, d) => sum + (d.cost || 0), 0);

  return (
    <Modal isOpen onClose={onClose} title={`Spend for "${apiKey.name}"`} size="full">
      {error && <p className="text-sm text-red-500">{error}</p>}
      {!usage && !error && <CardSkeleton />}
      {usage && (
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat
              label="Spent"
              value={fmtUsdExact(budget.spentUsd)}
              sub={usage.spendResetAt ? `since reset ${new Date(usage.spendResetAt).toLocaleDateString()}` : "lifetime"}
            />
            <Stat label="Budget" value={budget.budgetUsd === null ? "None" : fmtUsdExact(budget.budgetUsd)} />
            <Stat
              label="Remaining"
              value={budget.budgetUsd === null ? "—" : fmtUsdExact(budget.remainingUsd)}
              sub={budget.exhausted ? <span className="text-red-500">Budget used up</span> : null}
            />
            <Stat label="Requests" value={fmtCount(usage.requestCount)} sub={`last ${fmtRelative(usage.lastUsedAt)}`} />
          </div>

          {budget.budgetUsd !== null && (
            <div className="h-2 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-label="Budget spent"
              aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(1, fraction) * 100)}>
              <div className={`h-full rounded-full ${budgetTone(fraction)}`} style={{ width: `${Math.min(1, fraction) * 100}%` }} />
            </div>
          )}

          <div>
            <h3 className="text-[12.5px] font-semibold">
              Spend per day, last 30 days <span className="font-normal text-text-muted">· {fmtUsdExact(spent30d)}</span>
            </h3>
            <div className="mt-2.5">
              <ActivityChart daily={usage.daily} measure="cost" />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            <div>
              <h3 className="text-[12.5px] font-semibold">Spend by model <span className="font-normal text-text-muted">· lifetime</span></h3>
              <div className="mt-3 flex flex-col gap-2.5">
                {usage.byModel.length === 0 && <p className="text-sm text-text-muted">No requests recorded yet.</p>}
                {usage.byModel.map((m) => (
                  <div key={`${m.model}|${m.provider}`} className="grid grid-cols-[minmax(88px,160px)_1fr_auto] items-center gap-3">
                    <span className="truncate text-[12.5px] text-text-muted" title={`${m.model}${m.provider ? ` (${m.provider})` : ""} · ${m.requests} requests`}>
                      {m.model}
                    </span>
                    <span className="block h-2.5 overflow-hidden rounded-[5px] bg-surface-2">
                      <span className="block h-full rounded-[5px] bg-primary" style={{ width: `${(m.cost / maxModel) * 100}%` }} />
                    </span>
                    <span className="text-[12.5px] font-medium tabular-nums">{fmtUsdExact(m.cost)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h3 className="text-[12.5px] font-semibold">Latest requests</h3>
              {usage.recent.length === 0 ? (
                <p className="mt-3 text-sm text-text-muted">No requests recorded yet.</p>
              ) : (
                <table className="mt-2 w-full text-left text-xs tabular-nums">
                  <thead>
                    <tr className="text-[10.5px] uppercase tracking-[0.05em] text-text-subtle">
                      <th className="pb-1.5 pr-2 font-semibold">When</th>
                      <th className="pb-1.5 px-2 font-semibold">Model</th>
                      <th className="pb-1.5 px-2 text-right font-semibold">Tokens</th>
                      <th className="pb-1.5 pl-2 text-right font-semibold">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.recent.map((r, i) => (
                      <tr key={`${r.timestamp}-${i}`} className="border-t border-border/60">
                        <td className="py-1.5 pr-2 text-text-muted">{fmtRelative(r.timestamp)}</td>
                        <td className="max-w-[10rem] truncate py-1.5 px-2" title={r.model}>{r.model}</td>
                        <td className="py-1.5 px-2 text-right">{fmtCount(r.promptTokens + r.completionTokens)}</td>
                        <td className="py-1.5 pl-2 text-right">{fmtUsdExact(r.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

KeyUsageModal.propTypes = {
  apiKey: PropTypes.shape({ id: PropTypes.string.isRequired, name: PropTypes.string }).isRequired,
  onClose: PropTypes.func.isRequired,
};
