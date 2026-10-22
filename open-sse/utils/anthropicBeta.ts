// anthropic-beta handling for user-added Anthropic-compatible endpoints.
//
// The header is one comma-separated list of flags. Third-party gateways
// (Snowflake Cortex, checked 2026-10-19) accept some flags and 400 on the rest,
// naming them:
//   Unexpected value(s) `oauth-2025-04-20`, `redact-thinking-2026-02-12` for the
//   `anthropic-beta` header. Please consult our documentation ... or try again
//   without the header.
// Free probes can't see this (body validation runs first), so it's learned from
// the first real request: drop the named flags, retry once, remember them.

import { CLAUDE_BETA_BODY_FIELDS } from "../config/claudeMessageCompat.js";

export const BETA_HEADER_KEYS = ["anthropic-beta", "Anthropic-Beta"];

// Never sent to non-Anthropic hosts: it marks the request as first-party Claude Code.
const ALWAYS_STRIPPED = ["claude-code-20250219"];

export const splitBetas = (value: unknown): string[] =>
  String(value || "").split(",").map((s) => s.trim()).filter(Boolean);

// Rewrite the beta header(s) in place: drop ALWAYS_STRIPPED + `dropped`, or
// everything when `stripAll`. Removes the header when nothing is left.
export function filterBetaHeaders(
  headers: Record<string, unknown>,
  { dropped = [], stripAll = false }: { dropped?: readonly string[]; stripAll?: boolean } = {},
): Record<string, unknown> {
  const drop = new Set<string>([...ALWAYS_STRIPPED, ...dropped]);
  for (const key of BETA_HEADER_KEYS) {
    if (!(key in headers)) continue;
    const kept = stripAll ? [] : splitBetas(headers[key]).filter((f) => !drop.has(f));
    if (kept.length) headers[key] = kept.join(",");
    else delete headers[key];
  }
  return headers;
}

// Delete the body fields gated by a flag that won't be sent (`dropped`, or
// every flag when `stripAll`). Returns the body for chaining.
export function stripBetaBodyFields<T>(
  body: T,
  { dropped = [], stripAll = false }: { dropped?: readonly string[]; stripAll?: boolean } = {},
): T {
  if (!body || typeof body !== "object") return body;
  const record = body as Record<string, unknown>;
  for (const [flag, fields] of Object.entries(CLAUDE_BETA_BODY_FIELDS)) {
    if (!stripAll && !dropped.includes(flag)) continue;
    for (const field of fields) delete record[field];
  }
  return body;
}

const REJECTED_RE = /Unexpected value\(s\)\s+(.+?)\s+for the\s+`?anthropic-beta`?\s+header/i;

// Flags a 400 body says it rejected, or [] when the body isn't that error.
// Only flags the error names in backticks; never guesses.
export function parseRejectedBetas(bodyText: unknown): string[] {
  const m = REJECTED_RE.exec(String(bodyText || ""));
  if (!m) return [];
  return [...m[1].matchAll(/`([^`]+)`/g)].map((x) => x[1].trim()).filter(Boolean);
}
