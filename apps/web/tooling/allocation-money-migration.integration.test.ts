import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";
import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

it("preserves signed allocation edges and refuses noisy originals without changing ownership", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle({ client: client, paramsInErrors: true });
    await migrateDatabase(db, {
      through: "20261106014136_0104_purchase_total_minor_units",
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
    for (const [i, kind, code] of [
      [6, "financialTransaction", "FTX-SYNALLOC2"],
      [7, "purchase", "PUR-SYNALLOC2"],
    ] as const)
      await client.query(
        `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,$2,$3)`,
        [uuid(i), kind, code],
      );
    await client.query(
      `INSERT INTO "Purchase" (id,shortcode,"vendorId") VALUES ($1,'PUR-SYNALLOC2',$2)`,
      [uuid(7), uuid(1)],
    );
    await client.query(
      `INSERT INTO "FinancialTransaction" (id,shortcode,"accountId",kind,status,amount,"postedDate") VALUES ($1,'FTX-SYNALLOC2',$2,'purchase','posted',0.3,'2026-01-01')`,
      [uuid(6), uuid(3)],
    );
    for (const [i, amount] of [0.1, 0.2].entries())
      await client.query(
        `INSERT INTO "FinancialTransactionAllocation" (id,"transactionId","purchaseId",amount) VALUES ($1,$2,$3,$4)`,
        [uuid(i + 12), uuid(6), uuid(i === 0 ? 2 : 7), amount],
      );
    const snapshotBefore = JSON.stringify(
      (
        await client.query(
          `SELECT a.amount,(SELECT sum(coverage.amount) FROM "FinancialTransactionAllocation" coverage WHERE coverage."transactionId"=a."transactionId") AS "allocatedAmount" FROM "FinancialTransactionAllocation" a ORDER BY a.id`,
        )
      ).rows,
    );
    await client.query(
      `CREATE TABLE "AllocationConsumer" ("allocationId" uuid REFERENCES "FinancialTransactionAllocation"(id)); INSERT INTO "AllocationConsumer" SELECT id FROM "FinancialTransactionAllocation"`,
    );
    const run = uuid(90);
    await client.query(
      `INSERT INTO "user" (id,name,email) VALUES ('allocation-member','Synthetic member','allocation@example.test')`,
    );
    await client.query(
      `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,'run','RUN-SYNALLOC')`,
      [run],
    );
    await client.query(
      `INSERT INTO "Run" (id,shortcode,"actorName",trigger,"actorUserId","actorEmail",purpose,status) VALUES ($1,'RUN-SYNALLOC','Synthetic member','manual','allocation-member','allocation@example.test','sweep','running')`,
      [run],
    );
    await client.query(
      `INSERT INTO "RunStep" ("runId",key,label,position,state) VALUES ($1,'statement_generate','Synthetic refresh',0,'running')`,
      [run],
    );
    await client.query(
      `INSERT INTO "Job" (key,kind,state,"runId",input) VALUES ('allocation-refresh','run.execute','queued',$1,'{}')`,
      [run],
    );
    await expect(
      migrateDatabase(db, {
        through: "20261106015941_0105_allocation_minor_units",
      }),
    ).rejects.toThrow("Financial refresh has unfinished steps");
    await client.query(
      `UPDATE "Run" SET status='failed',"failureCode"='user_cancelled',"endedAt"=now() WHERE id=$1`,
      [run],
    );
    await expect(
      migrateDatabase(db, {
        through: "20261106015941_0105_allocation_minor_units",
      }),
    ).rejects.toThrow("Financial refresh has unfinished steps");
    await client.query(
      `UPDATE "Job" SET state='cancelled' WHERE key='allocation-refresh'`,
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
      migrateDatabase(db, {
        through: "20261106015941_0105_allocation_minor_units",
      }),
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
    await migrateDatabase(db, {
      through: "20261106015941_0105_allocation_minor_units",
    });
    expect(
      (
        await client.query(
          `SELECT "amountMinor"::text AS minor FROM "FinancialTransactionAllocation" ORDER BY id`,
        )
      ).rows,
    ).toEqual([
      { minor: "1001" },
      { minor: "-1002" },
      { minor: "10" },
      { minor: "20" },
    ]);
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
    ).toBe(4);
    // Raw execute fields are driver values: numeric text and exact numeric sums change retained snapshot bytes.
    const snapshotAfter = JSON.stringify(
      (
        await client.query(
          `SELECT a."amountMinor"::float8/100 AS amount,(SELECT sum(coverage."amountMinor"::float8/100) FROM "FinancialTransactionAllocation" coverage WHERE coverage."transactionId"=a."transactionId") AS "allocatedAmount" FROM "FinancialTransactionAllocation" a ORDER BY a.id`,
        )
      ).rows,
    );
    expect(snapshotAfter).toBe(snapshotBefore);
    await expect(
      client.query(
        `UPDATE "FinancialTransactionAllocation" SET "amountMinor"=0`,
      ),
    ).rejects.toThrow(
      "FinancialTransactionAllocation_amount_minor_range_check",
    );
  });
});
