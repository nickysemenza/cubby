import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { z } from "zod";

import { softDeleteTableCatalog } from "./schema-storage.ts";

test("recognizes inline, spread and generated deletedAt columns", () => {
  const schema = `const softDeletedAt = () => ({deletedAt: timestamp("deletedAt")});
    export const direct = pgTable("Direct", {deletedAt: timestamp("deletedAt")});
    export const spread = pgTable("Spread", {...softDeletedAt(), name: text("name")});
    export const generated = pgTable("Generated", generatedColumns());
    export const hard = pgTable("Hard", {name: text("name")});`;
  const catalog = softDeleteTableCatalog(schema, [
    `export const generatedColumns = () => ({deletedAt: timestamp("deletedAt")});`,
  ]);
  assert.deepEqual([...catalog.varNames], ["direct", "spread", "generated"]);
  assert.equal(catalog.sqlNameToVar.get("Generated"), "generated");
});

test("retains all physical soft-delete tables through generated storage migration", () => {
  const schema = readFileSync(
    new URL("../apps/web/src/server/db/schema.ts", import.meta.url),
    "utf8",
  );
  const columns = readFileSync(
    new URL(
      "../apps/web/src/server/db/generated/entity-columns.gen.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const baseline = z
    .object({
      tables: z.record(
        z.string(),
        z.object({
          name: z.string(),
          columns: z.record(z.string(), z.unknown()),
        }),
      ),
    })
    .parse(
      JSON.parse(
        readFileSync(
          new URL(
            "../apps/web/src/server/db/__snapshots__/application-schema.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    );
  const expected = Object.values(baseline.tables)
    .flatMap((table) => ("deletedAt" in table.columns ? [table.name] : []))
    .sort();
  assert.deepEqual(
    [...softDeleteTableCatalog(schema, [columns]).sqlNameToVar.keys()].sort(),
    expected,
  );
});
