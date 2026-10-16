import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";
import { z } from "zod";

const app = resolve(import.meta.dirname, "../../..");
const leaf = pathToFileURL(
  resolve(app, "src/server/db/generated/identity-storage-tables.gen.ts"),
).href;
const schema = pathToFileURL(resolve(app, "src/server/db/schema.ts")).href;
const identifiers = pathToFileURL(
  resolve(app, "src/server/db/external-identifier-tables.ts"),
).href;

describe("canonical storage table initialization", () => {
  for (const first of [leaf, schema]) {
    it(`keeps table identity and closed foreign keys when ${first === leaf ? "storage" : "assembly"} loads first`, () => {
      const result = execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `
        import assert from "node:assert/strict";
        import { getTableName } from "drizzle-orm";
        import { getTableConfig } from "drizzle-orm/pg-core";
        await import(${JSON.stringify(first)});
        const leaf = await import(${JSON.stringify(leaf)});
        const schema = await import(${JSON.stringify(schema)});
        const identifiers = await import(${JSON.stringify(identifiers)});
        const allowed = new Set([...Object.values(leaf).map(getTableName), getTableName(schema.entityIdentity)]);
        for (const [key, table] of Object.entries(leaf)) {
          assert.equal(table, schema[key], key);
          for (const fk of getTableConfig(table).foreignKeys)
            assert.ok(allowed.has(getTableName(fk.reference().foreignTable)), fk.getName());
        }
        assert.equal(identifiers.entityExternalId, schema.entityExternalId);
        assert.equal(identifiers.externalSource, schema.externalSource);
        console.log(JSON.stringify({ tables: Object.keys(leaf).length, external: getTableConfig(identifiers.entityExternalId).name }));
      `,
        ],
        {
          cwd: app,
          encoding: "utf8",
          env: {
            ...process.env,
            TSX_TSCONFIG_PATH: resolve(app, "tsconfig.json"),
          },
        },
      );
      const resultSchema = z
        .object({ tables: z.number(), external: z.string() })
        .parse(JSON.parse(result));
      expect(resultSchema.tables).toBeGreaterThan(0);
      expect(resultSchema.external).toBe("EntityExternalId");
    });
  }
});
