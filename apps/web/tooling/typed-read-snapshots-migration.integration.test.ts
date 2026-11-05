import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";
import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

it("carries SQL NULL and JSON null publications through every typed storage shape without changing member rows or tickets", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, { through: "0086_derived_read_views" });
    const emptyProduct = "00000000-0000-4000-8000-000000000011";
    const valuedProduct = "00000000-0000-4000-8000-000000000012";
    const project = "00000000-0000-4000-8000-000000000013";
    await client.query(
      `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,'product','PRD-SYNTHNULL'),($2,'product','PRD-SYNTHVALUE'),($3,'project','PRJ-SYNTHNULL')`,
      [emptyProduct, valuedProduct, project],
    );
    await client.query(
      `INSERT INTO "Product" (id,shortcode,name,price) VALUES ($1,'PRD-SYNTHNULL','Synthetic manual price',77),($2,'PRD-SYNTHVALUE','Synthetic derived price',NULL)`,
      [emptyProduct, valuedProduct],
    );
    await client.query(
      `INSERT INTO "Project" (id,shortcode,name) VALUES ($1,'PRJ-SYNTHNULL','Synthetic unset dates')`,
      [project],
    );
    const decision = {
      outcome: { kind: "empty", reason: "unset" },
      provenance: { kind: "computed" },
      evidence: { syntheticSource: null },
    };
    for (const [id, kind, key] of [
      [emptyProduct, "product", "price"],
      [emptyProduct, "product", "food"],
      [project, "project", "startDate"],
    ])
      await client.query(
        `INSERT INTO "DerivedValue" ("entityId",kind,key,value,"decidedBy","computedAt") VALUES ($1,$2,$3,NULL,$4::jsonb,'2026-01-01T12:00:00Z')`,
        [id, kind, key, JSON.stringify(decision)],
      );
    await client.query(
      `INSERT INTO "DerivedValue" ("entityId",kind,key,value,"sortNumber","decidedBy","computedAt") VALUES ($1,'product','price','12.5',12.5,'{"outcome":{"kind":"value"},"provenance":{"kind":"computed"}}','2026-01-01T12:00:00Z')`,
      [valuedProduct],
    );
    await client.query(
      `INSERT INTO "DerivedValue" ("entityId",kind,key,value,"decidedBy","computedAt") VALUES ($1,'product','food','null'::jsonb,$2::jsonb,'2026-01-01T12:00:00Z')`,
      [valuedProduct, JSON.stringify(decision)],
    );
    const preserved = async () =>
      (
        await client.query(`SELECT jsonb_build_object(
      'entities',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM "Entity" e),
      'products',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM "Product" p),
      'projects',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM "Project" p),
      'values',(SELECT jsonb_agg(to_jsonb(v) ORDER BY "entityId",key) FROM "DerivedValue" v),
      'tickets',(SELECT jsonb_agg(to_jsonb(w) ORDER BY target,ref) FROM "WorkItem" w)) AS value`)
      ).rows;
    const before = await preserved();
    await migrateDatabase(db, { through: "0087_typed_read_snapshots" });
    expect(await preserved()).toEqual(before);
    expect(
      (
        await client.query(
          `SELECT price IS NULL AS "numberNull", food IS NULL AS "jsonSqlNull", "priceDecision" AS decision,
      "priceComputedAt" = timestamp '2026-01-01T12:00:00Z' AS published FROM "ProductReadSnapshot" WHERE "entityId"=$1`,
          [emptyProduct],
        )
      ).rows,
    ).toEqual([
      { numberNull: true, jsonSqlNull: true, decision, published: true },
    ]);
    expect(
      (
        await client.query(
          `SELECT "startDate" IS NULL AS "textNull", "startDateDecision" AS decision,
      "startDateComputedAt" IS NOT NULL AS published FROM "ProjectReadSnapshot" WHERE "entityId"=$1`,
          [project],
        )
      ).rows,
    ).toEqual([{ textNull: true, decision, published: true }]);
    expect(
      (
        await client.query(
          `SELECT price,"priceSort",food='null'::jsonb AS "jsonNull" FROM "ProductReadSnapshot" WHERE "entityId"=$1`,
          [valuedProduct],
        )
      ).rows,
    ).toEqual([{ price: 12.5, priceSort: 12.5, jsonNull: true }]);
  });
});
