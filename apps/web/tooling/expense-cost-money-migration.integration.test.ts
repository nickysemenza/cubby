import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

const predecessor = "20261113012223_nappy_luke_cage";
const cutover = "20261113035856_expense_cost_minor_units";

// Failure modes: float residue changes a cent, a credit loses its sign, null
// becomes zero, a sub-cent original is rounded silently, or an old dollar
// writer still lands in the minor-unit column.
it("stores signed Expense costs as exact cents and refuses sub-cent originals", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle({ client, paramsInErrors: true });
    await migrateDatabase(db, { through: predecessor });
    const costs = [19.99, -12.34, 0, null, 0.1 + 0.2, 1234.56];
    for (const [i, cost] of costs.entries()) {
      const id = `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;
      const code = `EXP-SYNCOST${i}`;
      await client.query(
        `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,'expense',$2)`,
        [id, code],
      );
      await client.query(
        `INSERT INTO "Expense" (id,shortcode,name,cost,date,"costType")
         VALUES ($1,$2,'Synthetic line',$3,'2026-01-02','materials')`,
        [id, code, cost],
      );
    }
    const before = (
      await client.query(
        `SELECT jsonb_agg(to_jsonb(e)-'cost' ORDER BY id) AS rows FROM "Expense" e`,
      )
    ).rows[0].rows;

    // The predecessor check already forbids this; drop it to prove the abort.
    await client.query(
      `ALTER TABLE "Expense" DROP CONSTRAINT "Expense_cost_whole_cent_check"`,
    );
    await client.query(
      `UPDATE "Expense" SET cost=1.005 WHERE shortcode='EXP-SYNCOST5'`,
    );
    await expect(migrateDatabase(db, { through: cutover })).rejects.toThrow(
      "unproven whole-cent money",
    );
    expect(
      (
        await client.query(
          `SELECT to_regclass('archive."Expense_dollar_preimage"') AS archived`,
        )
      ).rows[0].archived,
    ).toBeNull();
    await client.query(
      `UPDATE "Expense" SET cost=1234.56 WHERE shortcode='EXP-SYNCOST5'`,
    );
    await client.query(
      `ALTER TABLE "Expense" ADD CONSTRAINT "Expense_cost_whole_cent_check"
       CHECK (cost IS NULL OR abs(cost * 100 - round(cost * 100)) < 0.0000001)`,
    );

    await migrateDatabase(db, { through: cutover });
    expect(
      (
        await client.query(
          `SELECT "costMinor"::text AS minor FROM "Expense" ORDER BY id`,
        )
      ).rows.map((row) => row.minor),
    ).toEqual(["1999", "-1234", "0", null, "30", "123456"]);
    expect(
      (
        await client.query(
          `SELECT jsonb_agg(to_jsonb(e)-'costMinor' ORDER BY id) AS rows FROM "Expense" e`,
        )
      ).rows[0].rows,
    ).toEqual(before);
    expect(
      (
        await client.query(
          `SELECT jsonb_agg(cost ORDER BY id) AS costs FROM archive."Expense_dollar_preimage"`,
        )
      ).rows[0].costs,
    ).toEqual(costs);
    await expect(
      client.query(
        `UPDATE "Expense" SET cost=19.99 WHERE shortcode='EXP-SYNCOST0'`,
      ),
    ).rejects.toThrow('column "cost" of relation "Expense" does not exist');
  });
});
