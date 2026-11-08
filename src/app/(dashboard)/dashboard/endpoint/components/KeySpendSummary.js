"use client";

import PropTypes from "prop-types";
import { budgetState, isKeyExpired } from "@/shared/utils/apiKeyLimits.js";
import { fmtCount, fmtRelative } from "../../accounts/[id]/formatters";
import { fmtUsdExact, budgetTone } from "./keyFormat";

/** One key's spend at a glance: spent / budget / remaining, requests, last use, limits. */
export default function KeySpendSummary({ apiKey }) {
  const budget = budgetState(apiKey);
  const fraction = budget.budgetUsd ? budget.spentUsd / budget.budgetUsd : budget.budgetUsd === 0 ? 1 : 0;
  const expired = isKeyExpired(apiKey);
  const models = apiKey.allowedModels || [];

  return (
    <div className="mt-2 max-w-md">
      {budget.budgetUsd !== null ? (
        <>
          <div className="flex items-baseline justify-between gap-3 text-xs tabular-nums">
            <span>
              <span className="font-semibold">{fmtUsdExact(budget.spentUsd)}</span>
              <span className="text-text-muted"> of {fmtUsdExact(budget.budgetUsd)}</span>
            </span>
            <span className={budget.exhausted ? "font-medium text-red-500" : "text-text-muted"}>
              {budget.exhausted ? "Budget used up" : `${fmtUsdExact(budget.remainingUsd)} left`}
            </span>
          </div>
          <div
            className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2"
            role="progressbar"
            aria-label="Budget spent"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(Math.min(1, fraction) * 100)}
          >
            <div className={`h-full rounded-full ${budgetTone(fraction)}`} style={{ width: `${Math.min(1, fraction) * 100}%` }} />
          </div>
        </>
      ) : (
        <p className="text-xs tabular-nums">
          <span className="font-semibold">{fmtUsdExact(budget.spentUsd)}</span>
          <span className="text-text-muted"> spent · no budget</span>
        </p>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
        <span>{fmtCount(apiKey.requestCount)} requests</span>
        <span aria-hidden="true">·</span>
        <span>last used {fmtRelative(apiKey.lastUsedAt)}</span>
        {models.length > 0 && (
          <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px]" title={models.join(", ")}>
            {models.length === 1 ? models[0] : `${models.length} models`}
          </span>
        )}
        {apiKey.expiresAt && (
          <span className={`rounded px-1.5 py-0.5 text-[11px] ${expired ? "bg-red-500/10 text-red-500" : "bg-surface-2"}`}>
            {expired ? "Expired" : `Expires ${fmtRelative(apiKey.expiresAt)}`}
          </span>
        )}
      </div>
    </div>
  );
}

KeySpendSummary.propTypes = {
  apiKey: PropTypes.shape({
    budgetUsd: PropTypes.number,
    spentUsd: PropTypes.number,
    requestCount: PropTypes.number,
    lastUsedAt: PropTypes.string,
    allowedModels: PropTypes.arrayOf(PropTypes.string),
    expiresAt: PropTypes.string,
  }).isRequired,
};
