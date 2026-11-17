// A CLI tool card that found a key it can't show (a custom key, or one saved for
// another endpoint) sends this instead of a key on Apply. The settings route then
// keeps the key already in the tool's config rather than overwriting it.
// No server imports: the cards import this too.
export const KEEP_EXISTING_KEY = "__keep_existing_key__";

export function isKeepExistingKey(value) {
  return value === KEEP_EXISTING_KEY;
}

export const KEEP_LABEL_HERE = "Custom key (kept)";
export const KEEP_LABEL_ELSEWHERE = "Custom key (not one of yours)";

// The label of the "keep the stored key" option, or null when there is no stored
// key the card can't name. keyStatus is a status route's { set, ownKeyId };
// pointsHere is whether the tool's stored base URL is this instance.
export function keepOptionLabel({ keyStatus, pointsHere }) {
  if (!keyStatus?.set || keyStatus.ownKeyId) return null;
  return pointsHere ? KEEP_LABEL_HERE : KEEP_LABEL_ELSEWHERE;
}

// What a card preselects when its status arrives: { value } (null = nothing to
// preselect), or null while the key list it needs hasn't loaded. The keep option's
// label comes from keepOptionLabel.
// - One of our keys: that key.
// - Another key, and the tool points at this instance: keep it.
// - Another key (another gateway's, or a deleted one), tool points elsewhere: our
//   first key, with the stored one still offered.
export function initialKeySelection({ keyStatus, pointsHere, apiKeys }) {
  if (keyStatus?.ownKeyId) {
    const own = apiKeys?.find((k) => k.id === keyStatus.ownKeyId);
    return own ? { value: own.key } : null;
  }
  if (!keyStatus?.set) return { value: null };
  if (pointsHere) return { value: KEEP_EXISTING_KEY };
  return apiKeys?.length > 0 ? { value: apiKeys[0].key } : null;
}
