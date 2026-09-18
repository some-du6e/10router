import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testsDir = fileURLToPath(new URL(".", import.meta.url));

export const sharedConfig = {
  test: {
    environment: "node",
    globals: true,
    // Keep the repository copies under .claude out of discovery. They do not
    // have the dependencies needed to collect the imported application code.
    exclude: ["**/node_modules/**", "**/.claude/**", "**/dist/**"],
    maxConcurrency: 10,
    silent: false,
  },
  resolve: {
    // Use array form so subpath aliases (for example, "@/lib/db/index.js")
    // resolve correctly.
    alias: [
      { find: /^open-sse\//, replacement: resolve(testsDir, "../open-sse") + "/" },
      { find: "open-sse", replacement: resolve(testsDir, "../open-sse") },
      { find: /^@\//, replacement: resolve(testsDir, "../src") + "/" },
    ],
  },
};

export function makeConfig({ include, exclude = [] }) {
  return {
    ...sharedConfig,
    test: {
      ...sharedConfig.test,
      include,
      exclude: [...sharedConfig.test.exclude, ...exclude],
    },
  };
}
