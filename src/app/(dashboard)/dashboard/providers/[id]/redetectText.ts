// What the endpoint page's Re-detect box says, and what it ticks by default.
// Kept out of the component so it can be tested on its own.
import type { RedetectDiff, RedetectPart } from "@/app/api/providers/[id]/redetect/diff.js";

// Which keys the check went through (see the redetect route).
export type RedetectKeys = {
  usedKey?: boolean;
  viaKeyUrl?: boolean;
  otherKeysFailed?: number;
  baseKeysTried?: number;
  partialReason?: string;
  removalsHeld?: boolean;
};

type Shown = RedetectDiff & RedetectKeys;

const sentence = (s: string) => `${s.replace(/\s*\.*\s*$/, "")}.`;

// "Nothing changed", for the half of the page that asked. A check through one
// key's own URL vouches only for that account's models, so it claims no more.
export function unchangedText(part: RedetectPart, viaKeyUrl: boolean): string {
  if (part === "models") return viaKeyUrl ? "No new models." : "Same models as you have now.";
  if (part === "endpoint") return viaKeyUrl ? "Nothing to change." : "No changes to the API, URL or fixes.";
  return viaKeyUrl ? "No new models." : "Same API, URL and models as when it was added.";
}

// What a check through one key's own URL (one account) couldn't vouch for.
export function keyUrlNote(part: RedetectPart, baseTried: boolean): string {
  const via = baseTried ? "The keys on the endpoint's URL gave no usable answer, so this was checked through one key's own URL" : "Checked through one key's own URL";
  if (part === "models") return `${via}, so models it lacks aren't offered for removal and model routes stay as they are.`;
  if (part === "endpoint") return `${via}, so the API, URL changes and fixes weren't checked.`;
  return `${via}, so the API, URL changes, fixes and model routes weren't checked, and models it lacks aren't offered for removal.`;
}

// The line under "Found N changes" / "Nothing changed".
export function summaryText(part: RedetectPart, diff: Shown): string {
  const n = diff.otherKeysFailed || 0;
  return [
    diff.changes ? "Pick what to apply. Free probes only, nothing was generated." : unchangedText(part, !!diff.viaKeyUrl || !!diff.removalsHeld),
    !diff.changes && diff.usedKey === false ? "No key, so only what's public was checked." : "",
    diff.partialReason ? sentence(diff.partialReason) : "",
    diff.viaKeyUrl ? keyUrlNote(part, !!diff.baseKeysTried) : "",
    diff.removalsHeld ? "Models missing from this key's list aren't offered for removal: it may list fewer than the key tried first." : "",
    n ? `${n === 1 ? "1 other key" : `${n} other keys`} didn't get through.` : "",
  ].filter(Boolean).join(" ");
}

// The red box: the error as one sentence, then that nothing was saved.
export function failedText(diff: Shown): string {
  return `${diff.error ? `${sentence(diff.error)} ` : ""}Nothing was changed.`;
}

// The "Fixes" row. An empty route map isn't offered: one API failing its probe
// (a 503) is enough to produce it, and applying it would strand routed models.
export function fixesList(q: RedetectDiff["quirks"]): string[] {
  return [
    q.maxCompletionTokens && "send max_completion_tokens",
    q.apiKeyHeader && "send the key in an api-key header",
    q.modelRoutes && Object.keys(q.modelRoutes).length > 0 && "send each model to the API that answers it",
  ].filter((x): x is string => !!x);
}

// Ticked to start with.
export function defaultPick(diff: Shown) {
  return {
    protocol: !!diff.protocol?.applicable,
    baseUrl: !!diff.baseUrl,
    add: !!diff.ok && diff.addModels.length > 0,
    remove: !!diff.ok && diff.removeModels.length > 0,
    outdated: false,
    quirks: true,
  };
}
