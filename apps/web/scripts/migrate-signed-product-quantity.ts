import "dotenv/config";
import { Client } from "pg";

/**
 * One-off, hand-applied migration: widen `Expense_productQuantity_check` to
 * allow a signed (non-zero) quantity, and flip the ledger's single genuine $0
 * discard so its sign carries the fact.
 *
 * This cannot ride on `db:push`: `drizzle-kit push` does not diff CHECK
 * constraints — it reports `Changes applied` and changes nothing (see the
 * warning in the root CLAUDE.md). The matching edit in `schema.ts` is still
 * required, because the integration-test template is built from `schema.ts` via
 * `pushSchema`; without both, tests exercise a constraint production lacks.
 *
 * Idempotent: re-running against an already-migrated database is a no-op that
 * still prints the verification output. Safe to run twice.
 *
 * Usage:
 *   pnpm --filter @cubby/web db:migrate-signed-quantity
 */

const EXPECTED_DEF =
  'CHECK ((("productQuantity" IS NULL) OR (("productId" IS NOT NULL) AND ("productQuantity" <> 0))))';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const client = new Client({ connectionString: databaseUrl });
await client.connect();

const readConstraint = async () => {
  const result = await client.query<{ def: string }>(
    `SELECT pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conrelid = '"Expense"'::regclass
        AND conname = 'Expense_productQuantity_check'`,
  );
  return result.rows[0]?.def ?? null;
};

const before = await readConstraint();
console.log("before:", before ?? "(constraint missing)");

if (before === EXPECTED_DEF) {
  console.log("constraint already widened — skipping the ALTER.");
} else {
  try {
    await client.query("BEGIN");
    // Drop first: the one backfilled row violates the old `> 0` predicate.
    await client.query(
      `ALTER TABLE "Expense" DROP CONSTRAINT "Expense_productQuantity_check"`,
    );
    await client.query(
      `ALTER TABLE "Expense" ADD CONSTRAINT "Expense_productQuantity_check"
         CHECK ("productQuantity" IS NULL
                OR ("productId" IS NOT NULL AND "productQuantity" <> 0))`,
    );
    // The whole quantity backfill. Of the live quantified $0 rows this is the
    // only genuine exit ("Discarded — Eastman Outdoors Portable Kahuna
    // Burner"); every other one is a free acquisition (promo pack, bundled
    // accessory, comped material) and correctly stays positive.
    const backfill = await client.query(
      `UPDATE "Expense" SET "productQuantity" = -"productQuantity"
        WHERE "shortcode" = 'EXP-2N4N' AND "cost" = 0 AND "productQuantity" = 1`,
    );
    if (backfill.rowCount !== 1) {
      throw new Error(
        `expected to backfill exactly 1 row, got ${backfill.rowCount}`,
      );
    }
    await client.query("COMMIT");
    console.log("committed; quantity backfilled rows:", backfill.rowCount);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("rolled back:", error);
    await client.end();
    process.exit(1);
  }
}

// A discard belongs to no vendor charge. That same row was attached to
// PUR-ZS9B — the 2022 Amazon order that *bought* the burner — so it inherited
// Amazon and the order id for an event four years later, and put a line on
// that order which was never part of it. `purchaseId` is nullable precisely
// for rows with nothing to attach to. New discards mint with `purchaseId:
// null` (see repo/product/discard.ts); this detaches the historical one.
// Money is unaffected: a $0 line contributes nothing to any purchase total,
// and PUR-ZS9B keeps its principal line so it does not become empty.
const detached = await client.query(
  `UPDATE "Expense" SET "purchaseId" = NULL
    WHERE "shortcode" = 'EXP-2N4N' AND "cost" = 0 AND "purchaseId" IS NOT NULL`,
);
console.log(
  "discard detached from its purchase:",
  detached.rowCount === 1
    ? "1 row ✓"
    : `${detached.rowCount} rows (already detached)`,
);

// Verification. `Changes applied` is never evidence — read the catalog back.
const after = await readConstraint();
console.log("after: ", after ?? "(constraint missing)");
if (after !== EXPECTED_DEF) {
  console.error("constraint definition does not match the expected shape.");
  process.exitCode = 1;
}

const counts = await client.query(
  `SELECT count(*) FILTER (WHERE "productQuantity" < 0) AS negative,
          count(*) FILTER (WHERE "productQuantity" = 0) AS zero,
          count(*) FILTER (WHERE "productQuantity" IS NOT NULL) AS quantified
     FROM "Expense" WHERE "deletedAt" IS NULL`,
);
console.log("counts:", counts.rows[0]);

// Prove the new constraint actually bites, then roll the probe back.
try {
  await client.query("BEGIN");
  await client.query(
    `UPDATE "Expense" SET "productQuantity" = 0 WHERE "shortcode" = 'EXP-2N4N'`,
  );
  console.error("constraint did NOT bite — quantity 0 was accepted.");
  process.exitCode = 1;
} catch (error) {
  const code = (error as { code?: string }).code;
  console.log(
    "zero rejected:",
    code === "23514" ? "23514 ✓" : `unexpected error ${String(code)}`,
  );
  if (code !== "23514") process.exitCode = 1;
} finally {
  await client.query("ROLLBACK");
}

await client.end();
