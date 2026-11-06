import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";
import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

it("preserves signed allocation edges and refuses noisy originals without changing ownership", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, {
      through: "0104_purchase_total_minor_units",
    });
    const uuid = (i: number) =>
      `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    for (const [i, kind, code] of [
      [1, "vendor", "VEN-SYNALLOC"],
      [2, "purchase", "PUR-SYNALLOC"],
      [3, "financialAccount", "FAC-SYNALLOC"],
      [4, "financialTransaction", "FTX-SYNALLOC0"],
      [5, "financialTransaction", "FTX-SYNALLOC1"],
    ] as const)
      await client.query(
        `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,$2,$3)`,
        [uuid(i), kind, code],
      );
    await client.query(
      `INSERT INTO "Vendor" (id,shortcode,name) VALUES ($1,'VEN-SYNALLOC','Synthetic vendor')`,
      [uuid(1)],
    );
    await client.query(
      `INSERT INTO "Purchase" (id,shortcode,"vendorId") VALUES ($1,'PUR-SYNALLOC',$2)`,
      [uuid(2), uuid(1)],
    );
    await client.query(
      `INSERT INTO "FinancialAccount" (id,shortcode,name,identity) VALUES ($1,'FAC-SYNALLOC','Synthetic cash','{"kind":"cash"}')`,
      [uuid(3)],
    );
    for (const [i, amount] of [10.01, -10.02].entries()) {
      await client.query(
        `INSERT INTO "FinancialTransaction" (id,shortcode,"accountId",kind,status,amount,"postedDate") VALUES ($1,$2,$3,$4,'posted',$5,'2026-01-01')`,
        [
          uuid(i + 4),
          `FTX-SYNALLOC${i}`,
          uuid(3),
          i === 0 ? "purchase" : "refund",
          amount,
        ],
      );
      await client.query(
        `INSERT INTO "FinancialTransactionAllocation" (id,"transactionId","purchaseId",amount,"confirmsMerchant","deletedAt") VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          uuid(i + 10),
          uuid(i + 4),
          uuid(2),
          amount,
          i === 0,
          i === 0 ? null : "2026-01-02",
        ],
      );
    }
    await client.query(
      `CREATE TABLE "AllocationConsumer" ("allocationId" uuid REFERENCES "FinancialTransactionAllocation"(id)); INSERT INTO "AllocationConsumer" SELECT id FROM "FinancialTransactionAllocation"`,
    );
    const before = (
      await client.query(
        `SELECT jsonb_agg(to_jsonb(a) ORDER BY id) AS rows FROM "FinancialTransactionAllocation" a`,
      )
    ).rows[0].rows;
    await client.query(
      `UPDATE "FinancialTransactionAllocation" SET amount=10.010000000000002 WHERE id=$1`,
      [uuid(10)],
    );
    await expect(
      migrateDatabase(db, { through: "0105_allocation_minor_units" }),
    ).rejects.toThrow("independent IEEE");
    expect(
      (
        await client.query(
          `SELECT to_regclass('archive."FinancialTransactionAllocation_dollar_preimage"') AS archived`,
        )
      ).rows[0].archived,
    ).toBeNull();
    await client.query(
      `UPDATE "FinancialTransactionAllocation" SET amount=10.01 WHERE id=$1`,
      [uuid(10)],
    );
    await migrateDatabase(db, { through: "0105_allocation_minor_units" });
    expect(
      (
        await client.query(
          `SELECT "amountMinor"::text AS minor FROM "FinancialTransactionAllocation" ORDER BY id`,
        )
      ).rows,
    ).toEqual([{ minor: "1001" }, { minor: "-1002" }]);
    expect(
      (
        await client.query(
          `SELECT jsonb_agg((to_jsonb(a)-'amountMinor')||jsonb_build_object('amount',"amountMinor"::numeric/100) ORDER BY id) AS rows FROM "FinancialTransactionAllocation" a`,
        )
      ).rows[0].rows,
    ).toEqual(before);
    expect(
      (
        await client.query(
          `SELECT jsonb_agg(to_jsonb(a) ORDER BY id) AS rows FROM archive."FinancialTransactionAllocation_dollar_preimage" a`,
        )
      ).rows[0].rows,
    ).toEqual(before);
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS count FROM "AllocationConsumer" c JOIN "FinancialTransactionAllocation" a ON a.id=c."allocationId" JOIN "Purchase" p ON p.id=a."purchaseId" JOIN "FinancialTransaction" f ON f.id=a."transactionId"`,
        )
      ).rows[0].count,
    ).toBe(2);
    await expect(
      client.query(
        `UPDATE "FinancialTransactionAllocation" SET "amountMinor"=0`,
      ),
    ).rejects.toThrow(
      "FinancialTransactionAllocation_amount_minor_range_check",
    );
  });
});
