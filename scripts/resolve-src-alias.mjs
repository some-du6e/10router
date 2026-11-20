import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

// TypeScript sources are imported with a `.js` specifier, as next.config.mjs's
// extensionAlias maps them for the bundle. A `.js` file that doesn't exist is
// looked up as `.ts` (Node 22.18+ runs it with its types stripped).
function withTsFallback(url) {
  if (!url.startsWith("file:") || !url.endsWith(".js")) return url;
  const file = fileURLToPath(url);
  if (existsSync(file)) return url;
  const ts = `${file.slice(0, -3)}.ts`;
  return existsSync(ts) ? pathToFileURL(ts).href : url;
}

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    return nextResolve(withTsFallback(pathToFileURL(path.join(srcRoot, specifier.slice(2))).href), context);
  }
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
    return nextResolve(withTsFallback(new URL(specifier, context.parentURL).href), context);
  }
  return nextResolve(specifier, context);
}
