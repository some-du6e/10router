import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel) => readFileSync(path.join(repoRoot, rel), "utf8");

describe("Dockerfile builder stage", () => {
  const dockerfile = read("Dockerfile");
  const builder = dockerfile.slice(dockerfile.indexOf("AS builder"), dockerfile.indexOf("AS runner"));
  // Instruction lines only: the comments mention both.
  const install = builder.search(/^\s+npm install$/m);
  const build = builder.search(/^RUN npm run build$/m);

  it("declares its build args after the installs, so a new SOURCE_COMMIT reuses their layers", () => {
    expect(install).toBeGreaterThan(-1);
    expect(builder.search(/^ARG /m)).toBeGreaterThan(install);
  });

  it("declares every build arg next build reads before it runs", () => {
    expect(build).toBeGreaterThan(install);
    for (const arg of ["SOURCE_COMMIT", "NEXT_PUBLIC_GA_ID", "NEXT_PUBLIC_CLOUD_URL"]) {
      const at = builder.search(new RegExp(`^ARG ${arg}$`, "m"));
      expect(at, arg).toBeGreaterThan(install);
      expect(at, arg).toBeLessThan(build);
    }
  });
});
