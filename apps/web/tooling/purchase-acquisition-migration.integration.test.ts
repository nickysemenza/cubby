import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrationTags, migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

// Failure modes: legacy links gain unsupported acquisition authority, or the
// deployed predecessor cannot keep creating ordinary links after expansion.
it("preserves legacy Purchase links and predecessor writes across acquisition expansion", async () => {
  await withMigrationDatabase(async (client) => {
    const tags = migrationTags();
    const index = tags.findIndex((tag) =>
      tag.endsWith("_confirmed_purchase_acquisition"),
    );
    const predecessor = tags[index - 1];
    const migration = tags[index];
    if (!predecessor || !migration)
      throw new Error("Acquisition migration predecessor missing");
    await migrateDatabase(drizzle(client), { through: predecessor });
    await client.query(
      `INSERT INTO "Vendor" (shortcode, name) VALUES ('VEN-4K7M', 'Synthetic Shop')`,
    );
    await client.query(
      `INSERT INTO "Product" (shortcode, name, manufacturer) VALUES ('PRD-4K7M', 'Synthetic tool', 'Synthetic Maker'), ('PRD-7M4K', 'Synthetic refill', 'Synthetic Maker')`,
    );
    await client.query(
      `INSERT INTO "Purchase" (shortcode, "vendorId") SELECT 'PUR-4K7M', id FROM "Vendor" WHERE shortcode = 'VEN-4K7M'`,
    );
    const insert = `INSERT INTO "EntityLink" (kind, "fromEntityId", "fromKind", "toEntityId", "toKind")
      SELECT 'purchaseProduct', p.id, 'purchase', item.id, 'product'
      FROM "Purchase" p, "Product" item WHERE p.shortcode = 'PUR-4K7M' AND item.shortcode = $1
      ON CONFLICT DO NOTHING`;
    await client.query(insert, ["PRD-4K7M"]);
    const before = (
      await client.query(
        `SELECT to_jsonb(link) AS row FROM "EntityLink" link ORDER BY id`,
      )
    ).rows;
    await migrateDatabase(drizzle(client), { through: migration });
    expect(
      (
        await client.query(
          `SELECT to_jsonb(link) - 'acquisitionConfirmed' AS row FROM "EntityLink" link ORDER BY id`,
        )
      ).rows,
    ).toEqual(before);
    expect(
      (await client.query(`SELECT "acquisitionConfirmed" FROM "EntityLink"`))
        .rows,
    ).toEqual([{ acquisitionConfirmed: false }]);
    await client.query(insert, ["PRD-7M4K"]);
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS count FROM "EntityLink" WHERE NOT "acquisitionConfirmed"`,
        )
      ).rows,
    ).toEqual([{ count: 2 }]);
    await client.query(
      `UPDATE "EntityLink" SET "acquisitionConfirmed" = true WHERE "toEntityId" = (SELECT id FROM "Product" WHERE shortcode = 'PRD-4K7M')`,
    );
    await client.query(insert, ["PRD-4K7M"]);
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS count FROM "EntityLink" WHERE "acquisitionConfirmed"`,
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
    expect(
      (
        await client.query(
          `SELECT (SELECT count(*)::int FROM "Expense") AS expenses, (SELECT count(*)::int FROM "InventoryEntry") AS stock`,
        )
      ).rows,
    ).toEqual([{ expenses: 0, stock: 0 }]);
  });
});
