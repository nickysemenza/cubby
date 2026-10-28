import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

it("retains service Cost publications and existing retry tickets during evidence backfill", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, { through: "0056_recipe_publication" });
    const queued = "00000000-0000-4000-8000-000000000001";
    const missing = "00000000-0000-4000-8000-000000000002";
    const captured = "00000000-0000-4000-8000-000000000003";
    for (const [id, code, evidence] of [
      [queued, "PRD-QUEUED", false],
      [missing, "PRD-MISSING", false],
      [captured, "PRD-CAPTURED", true],
    ] as const) {
      await client.query(
        `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,'product',$2)`,
        [id, code],
      );
      await client.query(
        `INSERT INTO "Product" (id,shortcode,name) VALUES ($1,$2,$2)`,
        [id, code],
      );
      await client.query(
        `INSERT INTO "DerivedValue" ("entityId",kind,key,value,"computedAt")
        VALUES ($1,'product','cost',$2,'2026-01-01T12:00:00Z')`,
        [
          id,
          JSON.stringify({
            kind: "service_charge",
            amount: 65,
            chargeCount: 2,
            latestCharge: 90,
            ...(evidence ? { chargeTotal: 130 } : {}),
          }),
        ],
      );
      await client.query(
        `INSERT INTO "DerivedValue" ("entityId",kind,key,value,"decidedBy","computedAt")
        VALUES ($1,'product','price','65',$2,'2026-01-01T12:00:00Z')`,
        [
          id,
          JSON.stringify({
            outcome: { kind: "value" },
            provenance: { kind: "computed" },
            ...(evidence
              ? { evidence: { knownCost: 130, knownUnitCount: 2 } }
              : {}),
          }),
        ],
      );
    }
    await client.query(
      `DELETE FROM "WorkItem" WHERE target IN ('product.cost','product.price')`,
    );
    await client.query(
      `INSERT INTO "WorkItem" (drain,target,ref,priority,attempts,"lastError","readyAt")
      SELECT 'derived:drain',target,$1,0,3,'Synthetic retry',now()+interval '1 hour'
      FROM (VALUES ('product.cost'),('product.price')) AS targets(target)`,
      [queued],
    );
    const publications = async () =>
      (
        await client.query(
          `SELECT * FROM "DerivedValue" WHERE key IN ('cost','price') ORDER BY "entityId",key`,
        )
      ).rows;
    const ticket = async () =>
      (
        await client.query(
          `SELECT * FROM "WorkItem" WHERE target IN ('product.cost','product.price') AND ref=$1 ORDER BY target`,
          [queued],
        )
      ).rows;
    const beforePublications = await publications();
    const beforeTicket = await ticket();
    await migrateDatabase(db, { through: "0057_publication_evidence" });
    expect(await publications()).toEqual(beforePublications);
    expect(await ticket()).toEqual(beforeTicket);
    expect(
      (
        await client.query(
          `SELECT ref,priority FROM "WorkItem" WHERE target='product.cost' ORDER BY ref`,
        )
      ).rows,
    ).toEqual([
      { ref: queued, priority: 0 },
      { ref: missing, priority: 2 },
    ]);
    expect(
      (
        await client.query(
          `SELECT ref,priority FROM "WorkItem" WHERE target='product.price' ORDER BY ref`,
        )
      ).rows,
    ).toEqual([
      { ref: queued, priority: 0 },
      { ref: missing, priority: 2 },
    ]);
  });
});
