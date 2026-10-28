import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

test("raw EXISTS guards must name their own live relation alias", () => {
  const directory = mkdtempSync(
    join(root, "apps/web/src/server/.lint-fixture-"),
  );
  const file = join(directory, "live-alias.ts");
  writeFileSync(
    file,
    [
      'const a = sql`EXISTS (SELECT 1 FROM "Product" p WHERE ${notDeleted("p")})`;',
      'const b = sql`EXISTS (SELECT 1 FROM "Product" p WHERE ${liveAliasSql("p")})`;',
      'const c = sql`EXISTS (SELECT 1 FROM "Product" p WHERE ${liveAliasSql("other")})`;',
      'const d = sql`EXISTS (SELECT 1 FROM "Product" p WHERE p.id = ${id})`;',
      'const e = sql`EXISTS (SELECT 1 FROM "Product" p WHERE ${liveAliasSql("p")} AND EXISTS (SELECT 1 FROM "InventoryEntry" ie WHERE ie."productId" = p.id))`;',
      'const f = drizzle.sql`SELECT 1 WHERE ${liveAliasSqlText("p")}`;',
      'const g = sql`SELECT 1 WHERE ${liveAliasSql("p")}`;',
      "void [a, b, c, d, e, f, g];",
    ].join("\n"),
  );
  try {
    const result = spawnSync(
      process.execPath,
      [
        join(root, "node_modules/oxlint/bin/oxlint"),
        "--config",
        join(root, ".oxlintrc.json"),
        "--format",
        "json",
        file,
      ],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(result.status, 1, result.stderr);
    const output: { diagnostics: { code: string; message: string }[] } =
      JSON.parse(result.stdout);
    const failures = output.diagnostics.filter(
      (entry) => entry.code === "cubby(require-soft-delete-filter)",
    );
    assert.equal(failures.length, 4, JSON.stringify(failures));
    assert.equal(
      failures.filter((entry) => entry.message.includes('"InventoryEntry"'))
        .length,
      2,
    );
    const textPredicates = output.diagnostics.filter(
      (entry) => entry.code === "cubby(no-raw-deleted-at-predicate)",
    );
    assert.equal(textPredicates.length, 1);
    assert.match(textPredicates[0]?.message ?? "", /binds as a value/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
