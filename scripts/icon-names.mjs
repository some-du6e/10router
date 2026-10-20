import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SCAN_DIRS = ["src", "open-sse"];
const EXTENSIONS = /\.(js|jsx|ts|tsx|mjs|cjs|json)$/;

// Icon names reach the DOM from JSX children, props, and data tables (nav
// items, provider metadata), so there is no reliable call-site pattern to
// grep. Take every snake_case word in the source that is also an icon name
// instead: over-inclusive, but a few spare glyphs cost bytes, while a missing
// one renders as its raw name.
export function collectIconNames(root, known) {
  const found = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (EXTENSIONS.test(entry.name)) {
        for (const word of readFileSync(path, "utf8").match(/[a-z0-9_]+/g) || []) {
          if (known.has(word)) found.add(word);
        }
      }
    }
  };
  for (const dir of SCAN_DIRS) walk(join(root, dir));
  return [...found].sort();
}
