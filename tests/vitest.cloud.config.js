import { defineConfig } from "vitest/config";
import { makeConfig } from "./vitest.shared.js";

export default defineConfig(makeConfig({
  include: ["unit/embeddings.cloud.test.js"],
}));
