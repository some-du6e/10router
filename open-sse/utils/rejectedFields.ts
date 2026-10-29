// Top-level body fields an upstream refuses to model.
//
// Strict gateways validate the body with pydantic and 400 on any field they
// don't know, naming it (Snowflake Cortex, 2026-10-29):
//   {"message":"safeguards: Extra inputs are not permitted"}
// Clients add new fields without notice, so the field is learned from the
// error: drop it, retry once, and leave it off later requests for the same
// endpoint and model. Memory only; a restart costs one failed attempt.

// A bare name before the colon: "messages.0.content.0.x: ..." is a nested
// field and is never matched.
const EXTRA_RE = /(?<![\w.\]])([A-Za-z_][\w-]*)\s*:\s*Extra inputs are not permitted/g;

// Never dropped, whatever an error says: the request means nothing without them.
const PROTECTED = new Set(["model", "messages", "input", "contents", "system", "max_tokens"]);

const MAX_KEYS = 500;
const learned = new Map<string, Set<string>>();

// Every string in a JSON error body, unescaped; the raw text when it isn't JSON.
function errorText(bodyText: unknown): string {
  const raw = String(bodyText || "");
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  try { walk(JSON.parse(raw)); } catch { return raw; }
  return out.join("\n");
}

// Field names a 400 body says are not permitted, or [] for any other error.
export function parseRejectedFields(bodyText: unknown): string[] {
  const names = [...errorText(bodyText).matchAll(EXTRA_RE)].map((m) => m[1]);
  return [...new Set(names)].filter((n) => !PROTECTED.has(n));
}

export function rejectedFieldsFor(key: string): string[] {
  return [...(learned.get(key) || [])];
}

export function rememberRejectedFields(key: string, fields: readonly string[]): void {
  if (!fields.length) return;
  if (!learned.has(key) && learned.size >= MAX_KEYS) learned.delete(learned.keys().next().value as string);
  learned.set(key, new Set([...(learned.get(key) || []), ...fields]));
}

export function resetRejectedFields(): void {
  learned.clear();
}

// A copy of body without `fields`; the same body when none of them is present.
export function withoutFields<T>(body: T, fields: readonly string[]): T {
  if (!body || typeof body !== "object" || !fields.some((f) => f in (body as object))) return body;
  const copy = { ...(body as Record<string, unknown>) };
  for (const f of fields) delete copy[f];
  return copy as T;
}
