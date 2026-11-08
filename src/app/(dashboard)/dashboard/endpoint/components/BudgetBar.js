"use client";

import PropTypes from "prop-types";
import { cn } from "@/shared/utils/cn";

/** How much of a key's budget is gone: primary, amber from 80%, red when used up. */
export default function BudgetBar({ fraction, className }) {
  const filled = Math.min(1, Math.max(0, fraction || 0));
  const tone = fraction >= 1 ? "bg-red-500" : fraction >= 0.8 ? "bg-amber-500" : "bg-primary";
  return (
    <div
      className={cn("overflow-hidden rounded-full bg-surface-2", className)}
      role="progressbar"
      aria-label="Budget spent"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(filled * 100)}
    >
      <div className={cn("h-full rounded-full", tone)} style={{ width: `${filled * 100}%` }} />
    </div>
  );
}

BudgetBar.propTypes = {
  fraction: PropTypes.number.isRequired,
  className: PropTypes.string,
};
