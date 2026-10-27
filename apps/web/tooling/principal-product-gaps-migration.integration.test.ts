import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

it("preserves principal evidence and queues existing quality through the derived drain", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, { through: "0040_background_derived_priority" });
    const vendor = "00000000-0000-4000-8000-000000000001";
    const purchase = "00000000-0000-4000-8000-000000000002";
    const expense = "00000000-0000-4000-8000-000000000003";
    await client.query(
      `INSERT INTO "Entity" (id, kind, shortcode) VALUES
      ($1, 'vendor', 'VEN-SYNTHETIC'), ($2, 'purchase', 'PUR-SYNTHETIC'),
      ($3, 'expense', 'EXP-SYNTHETIC')`,
      [vendor, purchase, expense],
    );
    await client.query(
      `INSERT INTO "Vendor" (id, shortcode, name)
      VALUES ($1, 'VEN-SYNTHETIC', 'Synthetic retained vendor')`,
      [vendor],
    );
    await client.query(
      `INSERT INTO "Purchase" (id, shortcode, "vendorId", "spendingCategoryOrigin")
      VALUES ($1, 'PUR-SYNTHETIC', $2, 'legacy')`,
      [purchase, vendor],
    );
    await client.query(
      `INSERT INTO "Expense" (id, shortcode, name, "purchaseId", cost, date, "costType", "lineKind", "lineBasis", "economicRole", notes)
      VALUES ($1, 'EXP-SYNTHETIC', 'Synthetic retained principal', $2, 12, '2026-09-01', 'materials', 'principal', 'item_line', 'vendor', 'Synthetic source evidence')`,
      [expense, purchase],
    );
    const retained = async () =>
      (
        await client.query(
          `SELECT to_jsonb(e) AS expense,
      to_jsonb(p) AS purchase FROM "Expense" e JOIN "Purchase" p ON p.id=e."purchaseId" WHERE e.id=$1`,
          [expense],
        )
      ).rows;
    const before = await retained();
    // A completed old publication has no remaining dirty mark.
    await client.query(`DELETE FROM "WorkItem"`);
    await migrateDatabase(db, {
      through: "0041_unclassified_principal_product_gaps",
    });
    expect(await retained()).toEqual(before);
    const marks = async () =>
      (
        await client.query(`SELECT target, ref, priority FROM "WorkItem"
      WHERE target IN ('expense.dataQuality', 'purchase.dataQuality') ORDER BY target`)
      ).rows;
    expect(await marks()).toEqual([
      { target: "expense.dataQuality", ref: expense, priority: 1 },
      { target: "purchase.dataQuality", ref: purchase, priority: 1 },
    ]);
    expect(
      (
        await client.query(`SELECT count(*)::int AS count FROM "JobInvalidationCapture"
      WHERE key='derived:drain'`)
      ).rows[0]?.count,
    ).toBeGreaterThan(0);
  });
});
