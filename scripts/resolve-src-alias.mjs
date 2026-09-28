import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    return nextResolve(pathToFileURL(path.join(srcRoot, specifier.slice(2))).href, context);
  }
  return nextResolve(specifier, context);
}
