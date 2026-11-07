import { moneyToMinor } from "@cubby/shared";
import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";
import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

it("preserves transaction money and attached allocation edges while refusing noisy originals", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle({ client: client, paramsInErrors: true });
    await migrateDatabase(db, {
      through: "20261106015941_0105_allocation_minor_units",
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
        `INSERT INTO "FinancialTransactionAllocation" (id,"transactionId","purchaseId","amountMinor","confirmsMerchant","deletedAt") VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          uuid(i + 10),
          uuid(i + 4),
          uuid(2),
          moneyToMinor(amount),
          i === 0,
          i === 0 ? null : "2026-01-02",
        ],
      );
    }
    await client.query(
      `CREATE TABLE "TransactionConsumer" ("transactionId" uuid REFERENCES "FinancialTransaction"(id)); INSERT INTO "TransactionConsumer" SELECT id FROM "FinancialTransaction"`,
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
        through: "20261106015941_0106_transaction_amount_minor_units",
      }),
    ).rejects.toThrow("Financial refresh has unfinished steps");
    await client.query(
      `UPDATE "Run" SET status='failed',"failureCode"='user_cancelled',"endedAt"=now() WHERE id=$1`,
      [run],
    );
    await expect(
      migrateDatabase(db, {
        through: "20261106015941_0106_transaction_amount_minor_units",
      }),
    ).rejects.toThrow("Financial refresh has unfinished steps");
    await client.query(
      `UPDATE "Job" SET state='cancelled' WHERE key='allocation-refresh'`,
    );
    const before = (
      await client.query(
        `SELECT jsonb_agg(to_jsonb(a) ORDER BY id) AS rows FROM "FinancialTransaction" a`,
      )
    ).rows[0].rows;
    const beforeRaw = (
      await client.query(
        `SELECT amount, to_jsonb(f) AS transaction FROM "FinancialTransaction" f ORDER BY id`,
      )
    ).rows;
    const beforeSqlJson = (
      await client.query(
        `SELECT to_jsonb(f)::text AS snapshot FROM "FinancialTransaction" f ORDER BY id`,
      )
    ).rows;
    await client.query(
      `UPDATE "FinancialTransaction" SET amount=10.010000000000002 WHERE id=$1`,
      [uuid(4)],
    );
    await expect(
      migrateDatabase(db, {
        through: "20261106015941_0106_transaction_amount_minor_units",
      }),
    ).rejects.toThrow("independent IEEE");
    expect(
      (
        await client.query(
          `SELECT to_regclass('archive."FinancialTransaction_dollar_preimage"') AS archived`,
        )
      ).rows[0].archived,
    ).toBeNull();
    await client.query(
      `UPDATE "FinancialTransaction" SET amount=10.01 WHERE id=$1`,
      [uuid(4)],
    );
    await migrateDatabase(db, {
      through: "20261106015941_0106_transaction_amount_minor_units",
    });
    expect(
      (
        await client.query(
          `SELECT "amountMinor"::text AS minor FROM "FinancialTransaction" ORDER BY id`,
        )
      ).rows,
    ).toEqual([{ minor: "1001" }, { minor: "-1002" }]);
    expect(
      (
        await client.query(
          `SELECT jsonb_agg((to_jsonb(a)-'amountMinor')||jsonb_build_object('amount',"amountMinor"::float8/100) ORDER BY id) AS rows FROM "FinancialTransaction" a`,
        )
      ).rows[0].rows,
    ).toEqual(before);
    expect(
      (
        await client.query(
          `SELECT jsonb_agg(to_jsonb(a) ORDER BY id) AS rows FROM archive."FinancialTransaction_dollar_preimage" a`,
        )
      ).rows[0].rows,
    ).toEqual(before);
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS count FROM "TransactionConsumer" c JOIN "FinancialTransaction" f ON f.id=c."transactionId" JOIN "FinancialTransactionAllocation" a ON a."transactionId"=f.id JOIN "Purchase" p ON p.id=a."purchaseId"`,
        )
      ).rows[0].count,
    ).toBe(2);
    expect(
      (
        await client.query(
          `SELECT (f."amountMinor"::float8/100) AS amount, (to_jsonb(f)-'amountMinor')||jsonb_build_object('amount',f."amountMinor"::float8/100) AS transaction FROM "FinancialTransaction" f ORDER BY id`,
        )
      ).rows,
    ).toEqual(beforeRaw);
    expect(
      (
        await client.query(
          `SELECT ((to_jsonb(f)-'amountMinor')||jsonb_build_object('amount',f."amountMinor"::float8/100))::text AS snapshot FROM "FinancialTransaction" f ORDER BY id`,
        )
      ).rows,
    ).toEqual(beforeSqlJson);
    await expect(
      client.query(`UPDATE "FinancialTransaction" SET "amountMinor"=0`),
    ).rejects.toThrow("FinancialTransaction_amount_minor_range_check");
  });
});
