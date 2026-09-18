import { defineConfig } from "vitest/config";
import { makeConfig } from "./vitest.shared.js";

export default defineConfig(makeConfig({
  include: ["**/*stress*.test.js", "unit/db-concurrent.test.js"],
}));
