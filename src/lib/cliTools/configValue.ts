// Values written into hand-built YAML, TOML and .env lines. Quotes, backslashes and
// control characters would let a value close its string and add keys or lines.
// `$` (bare $VAR as well as ${VAR}) and backticks are what env-file loaders and
// shells expand, so a value with them could pull another variable or a command in.
// Real base URLs, keys and model ids contain none of these.
const UNSAFE = /["\\`$\u0000-\u001f\u007f]/;

export function findUnsafeConfigValue(fields: Record<string, unknown>): string | null {
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || UNSAFE.test(value)) return name;
  }
  return null;
}
