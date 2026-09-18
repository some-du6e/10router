import { defineConfig } from "vitest/config";
import { makeConfig } from "./vitest.shared.js";

export default defineConfig(makeConfig({
  include: ["**/*e2e.test.js"],
}));
