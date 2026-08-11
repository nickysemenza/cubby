import "dotenv/config";
import { Client } from "pg";

/**
 * Seed `FinancialTransactionAllocation` from the transactions that already name
 * a Purchase: one allocation per linked transaction, for that transaction's full
 * amount.
 *
 * This is the backfill half of the expand step. The table ships empty and unread;
 * this fills it so the settlement reads can later switch onto it and be a
 * provable no-op — every transaction has exactly one allocation until someone
 * deliberately splits one.
 *
 * Usage:
 *   # 1. Review. This is the default — no flag writes anything.
 *   pnpm --filter @cubby/web db:backfill-settlement-allocations
 *
 *   # 2. Write, naming the count you reviewed. A mismatch aborts.
 *   pnpm --filter @cubby/web db:backfill-settlement-allocations -- --write --confirm-count=1802
 *
 * Three deliberate choices, each of which is a bug if reversed:
 *
 * 1. **INSERT only — it must never write to `Purchase` or `FinancialTransaction`.**
 *    Data-quality exceptions are fingerprinted as `<check>:<purchase.updatedAt
 *    epoch ms>` and detected as stale purely by that timestamp moving. Bumping
 *    `updatedAt` on the purchases involved would silently re-open every live
 *    exception at once, with no way to tell which were legitimately stale.
 *
 * 2. **The `NOT EXISTS` guard deliberately omits `deletedAt IS NULL`.** With a
 *    liveness filter, a soft-deleted allocation would fail the existence test and
 *    a re-run would insert a duplicate LIVE row. As written the script is exactly
 *    idempotent over both populations, and stays safe to re-run after the write
 *    path exists. `ON CONFLICT` cannot serve here — the unique index is partial.
 *
 * 3. **Soft-deleted transactions are included**, mirroring their `deletedAt` onto
 *    the allocation. `repointEdge` runs `liveOnly: true`, so those rows are
 *    already frozen; skipping them would lose their purchase association
 *    permanently once the mirror column is dropped. Every read path filters
 *    transaction liveness anyway, so they cost nothing.
 */

const SELECT_PENDING = `
  SELECT count(*)::int AS pending
  FROM "FinancialTransaction" ft
  WHERE ft."purchaseId" IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM "FinancialTransactionAllocation" a
      WHERE a."transactionId" = ft."id" AND a."purchaseId" = ft."purchaseId"
    )
`;

const INSERT_SQL = `
  INSERT INTO "FinancialTransactionAllocation"
    ("id","transactionId","purchaseId","amount","createdAt","updatedAt","deletedAt")
  SELECT gen_random_uuid(), ft."id", ft."purchaseId", ft."amount", now(), now(), ft."deletedAt"
  FROM "FinancialTransaction" ft
  WHERE ft."purchaseId" IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM "FinancialTransactionAllocation" a
      WHERE a."transactionId" = ft."id" AND a."purchaseId" = ft."purchaseId"
    )
`;

/** Post-write proof. Every figure must be zero except the counts. */
const VERIFY_SQL = `
  SELECT
    (SELECT count(*) FROM "FinancialTransaction" WHERE "purchaseId" IS NOT NULL)::int AS linked_transactions,
    (SELECT count(*) FROM "FinancialTransactionAllocation")::int AS allocations,
    (SELECT count(*) FROM (
       SELECT ft.id
       FROM "FinancialTransaction" ft
       JOIN "FinancialTransactionAllocation" a ON a."transactionId" = ft.id
       GROUP BY ft.id, ft."amount"
       HAVING round((sum(a."amount") * 100)::numeric) <> round((ft."amount" * 100)::numeric)
     ) s)::int AS sum_mismatches,
    (SELECT count(*) FROM "FinancialTransaction" ft
      FULL JOIN "FinancialTransactionAllocation" a ON a."transactionId" = ft.id
      WHERE ft."purchaseId" IS DISTINCT FROM a."purchaseId"
         OR (a.id IS NOT NULL AND (ft."deletedAt" IS NULL) <> (a."deletedAt" IS NULL))
    )::int AS disagreements,
    (SELECT count(*) FROM "Purchase" WHERE jsonb_array_length("dataExceptions") > 0 AND "deletedAt" IS NULL)::int AS purchases_with_exceptions,
    (SELECT COALESCE(sum(jsonb_array_length("dataExceptions")), 0) FROM "Purchase" WHERE "deletedAt" IS NULL)::int AS live_exceptions,
    (SELECT max("updatedAt") FROM "Purchase") AS max_purchase_updated
`;

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const confirmArg = args.find((a) => a.startsWith("--confirm-count="));
  const confirmCount = confirmArg
    ? Number(confirmArg.split("=")[1])
    : undefined;

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = new Client({ connectionString: url });
  await client.connect();

  try {
    const { rows } = await client.query<{ pending: number }>(SELECT_PENDING);
    const pending = rows[0]?.pending ?? 0;
    console.log(`Transactions awaiting an allocation: ${pending}`);

    if (!write) {
      console.log(
        `\nReview only. To write:\n  pnpm --filter @cubby/web db:backfill-settlement-allocations -- --write --confirm-count=${pending}`,
      );
      return;
    }
    if (confirmCount !== pending) {
      throw new Error(
        `Refusing to write: --confirm-count=${confirmCount ?? "(absent)"} does not match the ${pending} rows found now. Re-review and re-run.`,
      );
    }

    await client.query("BEGIN");
    const inserted = await client.query(INSERT_SQL);
    await client.query("COMMIT");
    console.log(`Inserted ${inserted.rowCount} allocations.`);

    const verify = await client.query(VERIFY_SQL);
    console.log("\nVerification:");
    console.table(verify.rows);
    const v = verify.rows[0];
    if (v.sum_mismatches !== 0 || v.disagreements !== 0) {
      throw new Error(
        "Backfill wrote rows that do not agree with their transactions — investigate before proceeding.",
      );
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
