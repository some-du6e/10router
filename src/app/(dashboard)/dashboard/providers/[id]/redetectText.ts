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
  keyScoped?: boolean;
};

type Shown = RedetectDiff & RedetectKeys;

const sentence = (s: string) => `${s.replace(/\s*\.*\s*$/, "")}.`;

// "Nothing changed", for the half of the page that asked. `scope`: "none"
// (the endpoint's URL), "url" (a key's own URL, every key having one: only the
// URL and removals unchecked) or "account" (one account among keys on the
// endpoint's URL: it vouches only for its models).
export type CheckScope = "none" | "url" | "account";
export function unchangedText(part: RedetectPart, scope: CheckScope): string {
  if (part === "models") return scope === "none" ? "Same models as you have now." : "No new models.";
  if (part === "endpoint") return scope === "none" ? "No changes to the API, URL or fixes." : scope === "url" ? "No changes to the API or fixes." : "Nothing to change.";
  return scope === "none" ? "Same API, URL and models as when it was added." : scope === "url" ? "Same API, no new models." : "No new models.";
}

// What a check through one key's own URL couldn't vouch for.
export function keyUrlNote(part: RedetectPart, baseTried: boolean, scope: CheckScope = "account"): string {
  if (scope === "url") {
    const via = "No key uses the endpoint's URL, so this was checked through one key's own URL";
    if (part === "models") return `${via}, and models it lacks aren't offered for removal.`;
    if (part === "endpoint") return `${via}, and URL changes weren't checked.`;
    return `${via}: URL changes weren't checked, and models it lacks aren't offered for removal.`;
  }
  const via = baseTried ? "The keys on the endpoint's URL didn't give a full answer, so this was checked through one key's own URL" : "Checked through one key's own URL";
  if (part === "models") return `${via}, so models it lacks aren't offered for removal and model routes stay as they are.`;
  if (part === "endpoint") return `${via}, so the API, URL changes and fixes weren't checked.`;
  return `${via}, so the API, URL changes, fixes and model routes weren't checked, and models it lacks aren't offered for removal.`;
}

const scopeOf = (diff: Shown): CheckScope => (!diff.viaKeyUrl ? "none" : diff.keyScoped ? "account" : "url");

// The line under "Found N changes" / "Nothing changed".
export function summaryText(part: RedetectPart, diff: Shown): string {
  const n = diff.otherKeysFailed || 0;
  return [
    diff.changes ? "Pick what to apply. Free probes only, nothing was generated." : unchangedText(part, diff.removalsHeld && !diff.viaKeyUrl ? "url" : scopeOf(diff)),
    !diff.changes && diff.usedKey === false ? "No key, so only what's public was checked." : "",
    diff.partialReason ? sentence(diff.partialReason) : "",
    diff.viaKeyUrl ? keyUrlNote(part, !!diff.baseKeysTried, scopeOf(diff)) : "",
    diff.removalsHeld ? "Models missing from this key's list aren't offered for removal: another key comes first, and lists can differ by key. Switch off keys that don't work to get them." : "",
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
