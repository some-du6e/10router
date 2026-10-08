import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const registry = new URL("../open-sse/providers/registry/", import.meta.url);
const files = readdirSync(registry).filter((file) => file.endsWith(".js") && file !== "index.js").sort();
const indexUrl = new URL("index.js", registry);
let source = readFileSync(indexUrl, "utf8");
// Preserve numbering and commented-out providers when regenerating the list.
const existing = [...source.matchAll(/import p(\d+) from "\.\/([^"\n]+)";/g)];
const known = new Set(existing.map((match) => match[2]));
let next = Math.max(-1, ...existing.map((match) => Number(match[1]))) + 1;
for (const file of files) {
  if (known.has(file)) continue;
  const name = `p${next++}`;
  source = source.replace("\nexport default [", `\nimport ${name} from "./${file}";\n\nexport default [`);
  source = source.replace(/\n\];\s*$/, `\n  ${name},\n];\n`);
}
writeFileSync(indexUrl, source);
