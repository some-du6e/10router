// Values written into hand-built YAML, TOML and .env lines. Quotes, backslashes and
// control characters would let a value close its string and add keys or lines.
const UNSAFE = /["\\\u0000-\u001f\u007f]/;

export function findUnsafeConfigValue(fields: Record<string, unknown>): string | null {
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || UNSAFE.test(value)) return name;
  }
  return null;
}
