import { readFileSync } from "node:fs";

import { entitySchema } from "@cubby/schemas/entity";
import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { storedDerived } from "~/server/db/derived-declarations";
import { getDb, withTransaction } from "~/server/db/helpers";
import { findPgError } from "~/server/errors/db-errors";
import {
  loadStoredDerived,
  storedDerivedSql,
} from "~/server/generic/derived/repo/read";
import {
  createProductIdentityFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

const priceDeclaration = storedDerived("product", "price");
if (!priceDeclaration) throw new Error("Missing Product price declaration");
const legacyEvidenceKey = "legacy";

const migration = readFileSync(
  new URL(
    "../../../../../drizzle/0045_field_envelope_decisions.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("field decision cache migration", () => {
  const ctx = withTestDb();

  it("retains values and frozen evidence while scheduling ambiguous empty snapshots", async () => {
    const products = await Promise.all(
      ["value", "empty", "typed"].map((name) =>
        createProductIdentityFixture(
          ctx.db,
          makeProductInput({
            name: `Synthetic migration ${name}`,
            price: null,
          }),
          ctx.actor,
        ),
      ),
    );
    const [valued, empty, typed] = products;
    if (!valued || !empty || !typed)
      throw new Error("Missing synthetic migration products");
    const legacy = {
      level: "inherited",
      source: {
        entity: "project",
        id: "PRJ-HISTORY",
        label: "Synthetic historical source",
      },
    };
    const typedDecision = {
      outcome: { kind: "empty", reason: "explicit_none" },
      provenance: { kind: "own", ownership: { kind: "record" } },
    };
    const liveBefore = await getDb(ctx.db).execute(
      sql`SELECT * FROM "WorkItem" WHERE target = 'product.quantityVariance' AND ref = ${valued.entityId}`,
    );
    expect(liveBefore.rows).toHaveLength(1);
    await withTransaction(ctx.db, async (tx) => {
      await tx.execute(
        sql`ALTER TABLE "WorkItem" DROP CONSTRAINT "WorkItem_no_retired_automatic_fields"`,
      );
      await tx.execute(
        sql`ALTER TABLE "DerivedValue" DROP CONSTRAINT "DerivedValue_no_retired_automatic_fields"`,
      );
      await tx.execute(
        sql`DELETE FROM "WorkItem" WHERE target = 'product.price'`,
      );
      await tx.execute(sql`
      INSERT INTO "DerivedValue" ("entityId", kind, key, value, "sortNumber", "decidedBy", "inputHash", "computedAt") VALUES
      (${valued.entityId}, ${entitySchema.enum.product}, 'ledgerExpectedQuantity', '13'::jsonb, 13, ${JSON.stringify(legacy)}::jsonb, 'synthetic-hash', '2026-10-01'),
      (${valued.entityId}, ${entitySchema.enum.product}, ${priceDeclaration.key}, '65'::jsonb, 65, '{"level":"computed"}'::jsonb, 'synthetic-ambiguous-price', '2026-10-01'),
      (${valued.entityId}, ${entitySchema.enum.product}, 'automaticFields', '{"categoryId":{"confidence":0.9}}'::jsonb, NULL, NULL, NULL, '2026-10-01'),
      (${empty.entityId}, ${entitySchema.enum.product}, ${priceDeclaration.key}, 'null'::jsonb, NULL, NULL, 'synthetic-empty-hash', '2026-10-01'),
      (${typed.entityId}, ${entitySchema.enum.product}, ${priceDeclaration.key}, 'null'::jsonb, NULL, ${JSON.stringify(typedDecision)}::jsonb, 'synthetic-typed-hash', '2026-10-01')`);
      await tx.execute(sql`
      INSERT INTO "WorkItem" (target, ref, priority, attempts, "lastError", "readyAt")
      VALUES ('product.price', ${empty.entityId}, 2, 3, 'Synthetic previous refresh failure', now() + interval '1 minute'),
      ('product.automaticFields', ${valued.entityId}, 0, 0, NULL, now()),
      ('product.automaticFields@0', ${valued.entityId}, 0, 0, NULL, now())`);
      for (const statement of migration.split("--> statement-breakpoint"))
        if (statement.trim()) await tx.execute(sql.raw(statement));
    });
    const values = await loadStoredDerived(
      ctx.db,
      "product",
      products.map((product) => product.entityId),
      ["price", "ledgerExpectedQuantity"],
    );
    expect(
      values.get(valued.entityId)?.get("ledgerExpectedQuantity"),
    ).toMatchObject({
      value: 13,
      resultExists: true,
      stale: true,
      decision: {
        outcome: { kind: "value", value: 13 },
        provenance: {
          kind: "inherited",
          source: { entityId: legacy.source.id },
        },
      },
    });
    expect(values.get(valued.entityId)?.get("price")).toMatchObject({
      value: 65,
      resultExists: false,
      stale: true,
    });
    const sortedPrice = await getDb(ctx.db).execute(
      sql`SELECT ${storedDerivedSql("product", "price", sql`${valued.entityId}::uuid`)} AS amount`,
    );
    expect(sortedPrice.rows[0]).toMatchObject({ amount: null });
    expect(values.get(empty.entityId)?.get("price")).toMatchObject({
      value: null,
      resultExists: false,
      stale: true,
      error: "Synthetic previous refresh failure",
    });
    expect(values.get(typed.entityId)?.get("price")).toMatchObject({
      resultExists: true,
      stale: false,
      decision: typedDecision,
    });
    const retained = await getDb(ctx.db).execute(
      sql`SELECT "sortNumber", "inputHash", "decidedBy"->${legacyEvidenceKey} AS legacy FROM "DerivedValue" WHERE "entityId" = ${valued.entityId} AND key = 'ledgerExpectedQuantity'`,
    );
    expect(retained.rows[0]).toMatchObject({
      sortNumber: 13,
      inputHash: "synthetic-hash",
      legacy,
    });
    const work = await getDb(ctx.db).execute(
      sql`SELECT attempts, "lastError" FROM "WorkItem" WHERE target = 'product.price' AND ref = ${empty.entityId}`,
    );
    expect(work.rows[0]).toMatchObject({
      attempts: 3,
      lastError: "Synthetic previous refresh failure",
    });
    const liveAfter = await getDb(ctx.db).execute(
      sql`SELECT * FROM "WorkItem" WHERE target = 'product.quantityVariance' AND ref = ${valued.entityId}`,
    );
    expect(liveAfter.rows).toEqual(liveBefore.rows);
    const retired = await getDb(ctx.db)
      .execute(sql`SELECT key FROM "DerivedValue" WHERE key = 'automaticFields'
      UNION ALL SELECT target FROM "WorkItem" WHERE split_part(target, '@', 1) LIKE '%.automaticFields'`);
    expect(retired.rows).toEqual([]);
    const lateMark = await getDb(ctx.db)
      .execute(
        sql`INSERT INTO "WorkItem" (target, ref) VALUES ('product.automaticFields@0', ${valued.entityId})`,
      )
      .then(() => null, findPgError);
    expect(lateMark).toMatchObject({
      code: "23514",
      constraint: "WorkItem_no_retired_automatic_fields",
    });
    const lateValue = await getDb(ctx.db)
      .execute(
        sql`INSERT INTO "DerivedValue" ("entityId", kind, key, value, "computedAt") VALUES (${valued.entityId}, ${entitySchema.enum.product}, 'automaticFields', '{}'::jsonb, now())`,
      )
      .then(() => null, findPgError);
    expect(lateValue).toMatchObject({
      code: "23514",
      constraint: "DerivedValue_no_retired_automatic_fields",
    });
  });
});
