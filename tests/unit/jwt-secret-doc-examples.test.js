import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MIN_JWT_SECRET_LENGTH,
  PLACEHOLDER_JWT_SECRETS,
  isUsableJwtSecret,
} from "../../src/lib/auth/authSecret.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(full);
    return [full];
  });
}

// Everything an operator might copy a JWT_SECRET from.
function docFiles() {
  const top = fs.readdirSync(ROOT).filter((name) => /^(README.*|docker-compose.*|\.env\.example|.*\.md)$/.test(name));
  return [
    ...top.map((name) => path.join(ROOT, name)),
    ...walk(path.join(ROOT, "i18n")),
    ...walk(path.join(ROOT, "gitbook")),
    ...walk(path.join(ROOT, "docs")),
  ].filter((file) => fs.statSync(file).isFile() && path.basename(file) !== "CHANGELOG.md");
}

// `JWT_SECRET=value`, `JWT_SECRET: value`, `-e JWT_SECRET="value"`. Shell or
// compose expansions ($(...), ${...}) and <placeholders> are not literals.
// Spaces and tabs only, so a bare `JWT_SECRET:` heading never reads the next line.
const ASSIGNMENT = /JWT_SECRET[ \t]*[=:][ \t]*["']?([^\s"'`|]+)/g;

function literalsIn(text) {
  const found = [];
  for (const match of text.matchAll(ASSIGNMENT)) {
    const value = match[1].trim();
    if (!value || value.startsWith("$") || value.startsWith("<")) continue;
    found.push(value);
  }
  return found;
}

function literalExamples() {
  return docFiles().flatMap((file) => literalsIn(fs.readFileSync(file, "utf8")).map((value) => ({ file: path.relative(ROOT, file), value })));
}

describe("JWT_SECRET examples in the docs", () => {
  it("reads every way the docs write an assignment, and nothing else", () => {
    expect(literalsIn("JWT_SECRET=x1")).toEqual(["x1"]);
    expect(literalsIn("  JWT_SECRET: x2")).toEqual(["x2"]);
    expect(literalsIn('docker run -e "JWT_SECRET=x3" image')).toEqual(["x3"]);
    expect(literalsIn("export JWT_SECRET='x4'")).toEqual(["x4"]);
    expect(literalsIn('JWT_SECRET="$(openssl rand -hex 32)"')).toEqual([]);
    expect(literalsIn("- JWT_SECRET=${JWT_SECRET}")).toEqual([]);
    expect(literalsIn("JWT_SECRET:\nnext-line-value")).toEqual([]);
  });

  it("scans the files it is meant to", () => {
    const files = docFiles().map((file) => path.relative(ROOT, file));
    expect(files).toContain(".env.example");
    expect(files).toContain("README.md");
    expect(files.some((file) => file.startsWith(`gitbook${path.sep}`))).toBe(true);
  });

  it("every literal example long enough to pass the length rule is a known placeholder", () => {
    const usable = literalExamples().filter(({ value }) => value.length >= MIN_JWT_SECRET_LENGTH && isUsableJwtSecret(value));
    // A new doc example needs adding to PLACEHOLDER_JWT_SECRETS, or the doc should
    // tell people to generate one (openssl rand -hex 32) instead.
    expect(usable).toEqual([]);
  });

  it("refuses every listed placeholder even though each is long enough", () => {
    for (const value of PLACEHOLDER_JWT_SECRETS) {
      expect(value.length).toBeGreaterThanOrEqual(MIN_JWT_SECRET_LENGTH);
      expect(isUsableJwtSecret(value)).toBe(false);
      expect(isUsableJwtSecret(`  ${value}  `)).toBe(false);
    }
    expect(isUsableJwtSecret("9router-default-secret-change-me")).toBe(false);
  });
});
