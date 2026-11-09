// What the endpoint page's Re-detect box says, and what it ticks by default.
// Kept out of the component so it can be tested on its own.
import type { RedetectDiff, RedetectPart } from "@/app/api/providers/[id]/redetect/diff.js";

// Which keys the check went through (see the redetect route).
export type RedetectKeys = {
  usedKey?: boolean;
  viaKeyUrl?: boolean;
  otherKeysFailed?: number;
  baseKeysFailed?: number;
  partialReason?: string;
};

type Shown = RedetectDiff & RedetectKeys;

const sentence = (s: string) => `${s.replace(/\s*\.*\s*$/, "")}.`;

// "Nothing changed", for the half of the page that asked. A check through one
// key's own URL didn't ask the endpoint's URL, so it doesn't claim it.
export function unchangedText(part: RedetectPart, viaKeyUrl: boolean): string {
  if (part === "models") return viaKeyUrl ? "No new models." : "Same models as you have now.";
  if (part === "endpoint") return viaKeyUrl ? "No changes to the API or fixes." : "No changes to the API, URL or fixes.";
  return viaKeyUrl ? "Same API, no new models." : "Same API, URL and models as when it was added.";
}

// What a check through one key's own URL (one account) couldn't vouch for.
export function keyUrlNote(part: RedetectPart, baseFailed: boolean): string {
  const via = baseFailed ? "The keys on the endpoint's URL didn't get through, so this was checked through one key's own URL" : "Checked through one key's own URL";
  if (part === "models") return `${via}, so models it lacks aren't offered for removal and model routes stay as they are.`;
  if (part === "endpoint") return `${via}, so URL changes and key style weren't checked.`;
  return `${via}, so URL changes, key style and model routes weren't checked, and models it lacks aren't offered for removal.`;
}

// The line under "Found N changes" / "Nothing changed".
export function summaryText(part: RedetectPart, diff: Shown): string {
  const n = diff.otherKeysFailed || 0;
  return [
    diff.changes ? "Pick what to apply. Free probes only, nothing was generated." : unchangedText(part, !!diff.viaKeyUrl),
    !diff.changes && diff.usedKey === false ? "No key, so only what's public was checked." : "",
    diff.partialReason ? sentence(diff.partialReason) : "",
    diff.viaKeyUrl ? keyUrlNote(part, !!diff.baseKeysFailed) : "",
    n ? `${n === 1 ? "1 other key" : `${n} other keys`} didn't get through.` : "",
  ].filter(Boolean).join(" ");
}

// The red box: the error as one sentence, then that nothing was saved.
export function failedText(diff: Shown): string {
  return `${diff.error ? `${sentence(diff.error)} ` : ""}Nothing was changed.`;
}

// The "Fixes" row. An empty route map clears routes the endpoint no longer needs.
export function fixesList(q: RedetectDiff["quirks"]): string[] {
  return [
    q.maxCompletionTokens && "send max_completion_tokens",
    q.apiKeyHeader && "send the key in an api-key header",
    q.modelRoutes && (Object.keys(q.modelRoutes).length > 0 ? "send each model to the API that answers it" : "stop sending models to other APIs"),
  ].filter((x): x is string => !!x);
}

// Ticked to start with. An API switch seen through one key's own URL is one
// account's answer, so the user opts in.
export function defaultPick(diff: Shown) {
  return {
    protocol: !!diff.protocol?.applicable && !diff.viaKeyUrl,
    baseUrl: !!diff.baseUrl,
    add: !!diff.ok && diff.addModels.length > 0,
    remove: !!diff.ok && diff.removeModels.length > 0,
    outdated: false,
    quirks: true,
  };
}
