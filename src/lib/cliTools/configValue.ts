// Values a CLI tool settings route takes from the request and writes into a
// tool's config (base URL, key, model ids). Two ways such a value could do more
// than it says:
// - Hand-built YAML, TOML and .env lines: quotes, backslashes and control
//   characters would let it close its string and add keys or lines.
// - The tool's own substitution, which would make it pull in a variable or file
//   from the user's machine and send it to whatever base URL is set:
//     Hermes      config.yaml: ${VAR}, ${env:VAR}
//     OpenCode    opencode.json: {env:VAR}, {file:path} anywhere in the file
//     Kilo Code   OpenCode-based: {env:VAR}, {file:path}
//     OpenClaw    openclaw.json: ${VAR} in any string (process env and
//                 ~/.openclaw/.env), and an object apiKey ({ source: "env", ... })
//     Droid       settings.json: ${VAR} in customModels apiKey
//     jcode       provider .env file: $VAR / ${VAR} for dotenv-style loaders
//     DeepSeek TUI, Grok Build, Codex, Claude Code, Cline, Copilot, Cowork:
//                 no documented substitution in these values; held to the same
//                 rule, so a newer version that adds one can't be reached.
//   Shells and env loaders also expand bare $VAR and backticks.
// So every such value must be a string without any of: " \ ` $ { } and control
// characters. Real base URLs, keys and model ids contain none of these.
const UNSAFE = /["\\`${}\u0000-\u001f\u007f]/;

/**
 * The name of the first field that isn't a safe string, or null. undefined and
 * null fields are skipped (optional); anything else that isn't a string fails.
 */
export function findUnsafeConfigValue(fields: Record<string, unknown>): string | null {
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || UNSAFE.test(value)) return name;
  }
  return null;
}

/** A list's items as fields for findUnsafeConfigValue: { "models[0]": ..., ... }. */
export function listFields(name: string, list: unknown): Record<string, unknown> {
  if (!Array.isArray(list)) return { [name]: list };
  return Object.fromEntries(list.map((item, i) => [`${name}[${i}]`, item]));
}
