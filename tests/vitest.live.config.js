import { defineConfig } from "vitest/config";
import { makeConfig } from "./vitest.shared.js";

export default defineConfig(makeConfig({
  include: [
    "translator/**/*.real.test.js",
    "unit/*.live.test.js",
    "unit/antigravity-cache.test.js",
  ],
}));
