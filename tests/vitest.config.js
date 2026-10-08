import { defineConfig } from "vitest/config";
import { makeConfig } from "./vitest.shared.js";

// The default command is deliberately boring: deterministic Vitest tests only.
// Integration, live, benchmark, stress, and cloud suites have explicit
// commands below in tests/package.json.
export default defineConfig(makeConfig({
  include: ["auth/**/*.test.js", "unit/**/*.test.js", "translator/**/*.test.js"],
  exclude: [
    "unit/antigravity-cache.test.js",
    "unit/db-benchmark.test.js",
    "unit/db-concurrent.test.js",
    "unit/embeddings.cloud.test.js",
    "unit/mimo-free.live.test.js",
    "**/*.real.test.js",
    "**/*.live.test.js",
    "**/*e2e.test.js",
    "**/*benchmark*.test.js",
    "**/*stress*.test.js",
  ],
}));
