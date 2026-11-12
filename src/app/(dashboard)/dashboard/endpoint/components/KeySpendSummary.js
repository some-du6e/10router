"use client";

import PropTypes from "prop-types";
import { Badge } from "@/shared/components";
import { budgetState, isKeyExpired } from "@/shared/utils/apiKeyLimits.js";
import { fmtCount, fmtRelative } from "../../accounts/[id]/formatters";
import { fmtUsdExact } from "./keyFormat";
import BudgetBar from "./BudgetBar";

/** One key's spend at a glance: spent / budget / remaining, requests, last use, limits. */
export default function KeySpendSummary({ apiKey }) {
  const budget = budgetState(apiKey);
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
          <BudgetBar fraction={budget.fraction} className="mt-1 h-1.5" />
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
          <span title={models.join(", ")}>
            <Badge size="sm">{models.length === 1 ? models[0] : `${models.length} models`}</Badge>
          </span>
        )}
        {apiKey.expiresAt && (
          <Badge size="sm" variant={expired ? "error" : "default"}>
            {expired ? "Expired" : `Expires ${fmtRelative(apiKey.expiresAt)}`}
          </Badge>
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
