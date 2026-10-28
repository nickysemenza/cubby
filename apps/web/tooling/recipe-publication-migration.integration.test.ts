import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

it("retains Recipe payloads and only backfills missing publication identities", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, { through: "0055_job_lease_holder" });
    const fresh = "00000000-0000-4000-8000-000000000001";
    const stale = "00000000-0000-4000-8000-000000000002";
    for (const [id, code, stamp] of [
      [fresh, "RCP-FRESH", "2026-01-01T12:00:00Z"],
      [stale, "RCP-STALE", null],
    ]) {
      await client.query(
        `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,'recipe',$2)`,
        [id, code],
      );
      await client.query(
        `INSERT INTO "Recipe" (id,shortcode,name,totals,"totalsComputedAt")
        VALUES ($1,$2,$2,'{"cost":{"status":"known","lower":4,"upper":4}}',$3)`,
        [id, code, stamp],
      );
    }
    await client.query(`DELETE FROM "WorkItem" WHERE target='recipe.totals'`);
    await client.query(
      `INSERT INTO "WorkItem" (drain,target,ref,priority)
      VALUES ('derived:drain','recipe.totals',$1,0)`,
      [fresh],
    );
    const existingWork = (
      await client.query(
        `SELECT * FROM "WorkItem"
      WHERE target='recipe.totals' AND ref=$1`,
        [fresh],
      )
    ).rows;
    const preserved = async () =>
      (
        await client.query(
          `SELECT to_jsonb(r)-'totalsPublishedAt' AS value FROM "Recipe" r ORDER BY id`,
        )
      ).rows;
    const before = await preserved();
    await migrateDatabase(db, { through: "0056_recipe_publication" });
    expect(await preserved()).toEqual(before);
    expect(
      (
        await client.query(
          `SELECT id FROM "Recipe" WHERE "totalsPublishedAt"="totalsComputedAt"`,
        )
      ).rows,
    ).toEqual([{ id: fresh }]);
    expect(
      (
        await client.query(
          `SELECT id FROM "Recipe" WHERE "totalsPublishedAt" IS NULL`,
        )
      ).rows,
    ).toEqual([{ id: stale }]);
    expect(
      (
        await client.query(
          `SELECT ref,priority FROM "WorkItem" WHERE target='recipe.totals' AND ref=$1`,
          [stale],
        )
      ).rows,
    ).toEqual([{ ref: stale, priority: 2 }]);
    expect(
      (
        await client.query(
          `SELECT * FROM "WorkItem"
      WHERE target='recipe.totals' AND ref=$1`,
          [fresh],
        )
      ).rows,
    ).toEqual(existingWork);
  });
});
