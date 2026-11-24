// The Go gateway's schema manifest (gateway/internal/db/manifest.json) says
// what it reads in Node's database. It must match this repo's schema, or the
// gateway would read a column that isn't there, or refuse a schema it can read.
// See docs/GO_GATEWAY.md, "Schema ownership".
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { TABLES, buildCreateTableSql } from "@/lib/db/schema.js";
import { latestVersion } from "@/lib/db/migrations/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const GATEWAY_DB = path.join(ROOT, "gateway/internal/db");
const manifest = JSON.parse(fs.readFileSync(path.join(GATEWAY_DB, "manifest.json"), "utf8"));

it("knows the latest migration", () => {
  expect(manifest.schemaVersion, [
    "A migration was added. If it changes a table or column the gateway reads (manifest.json's tables),",
    "update the Go readers and writers in gateway/internal/db; then set schemaVersion to the new migration.",
  ].join(" ")).toBe(latestVersion());
});

it("reads only columns schema.js has", () => {
  const missing = [];
  for (const [table, columns] of Object.entries(manifest.tables)) {
    for (const col of columns) if (!TABLES[table]?.columns?.[col]) missing.push(`${table}.${col}`);
  }
  expect(missing).toEqual([]);
});

it("shares a file only with the drivers that keep it on disk", () => {
  const adapters = path.join(ROOT, "src/lib/db/adapters");
  const drivers = fs.readdirSync(adapters)
    .map((f) => fs.readFileSync(path.join(adapters, f), "utf8").match(/driver: "([^"]+)"/)?.[1])
    .filter(Boolean);
  expect([...drivers].sort()).toEqual(["better-sqlite3", "bun:sqlite", "node:sqlite", "sql.js"]);
  expect([...manifest.drivers].sort()).toEqual(drivers.filter((d) => d !== "sql.js").sort());
});

it("builds the Go tests' databases with the schema migrations make", () => {
  const sql = Object.entries(TABLES)
    .flatMap(([name, def]) => [`${buildCreateTableSql(name, def)};`, ...(def.indexes || []).map((i) => `${i};`)])
    .join("\n") + "\n";
  expect(fs.readFileSync(path.join(GATEWAY_DB, "testdata/schema.sql"), "utf8"),
    "gateway/internal/db/testdata/schema.sql is out of date: regenerate it from TABLES (this test's expected value)").toBe(sql);
});
