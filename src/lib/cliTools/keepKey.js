// A CLI tool card that found a key it can't show (a custom key, or one saved for
// another endpoint) sends this instead of a key on Apply. The settings route then
// keeps the key already in the tool's config rather than overwriting it.
// No server imports: the cards import this too.
export const KEEP_EXISTING_KEY = "__keep_existing_key__";

export function isKeepExistingKey(value) {
  return value === KEEP_EXISTING_KEY;
}
