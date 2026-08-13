import "dotenv/config";
import { Client } from "pg";

/**
 * Mark the products whose shelf presence is deliberately not tracked.
 *
 * `Product.stockTracked` is nullable on purpose: `null` = undecided (the "Not
 * on a shelf" worklist), `false` = reviewed, no shelf claim wanted, `true` =
 * tracked. Food and software are the two categories that can be answered
 * mechanically — you do not keep a shelf record for a can of tomatoes, and a
 * software licence is not physical at all — so this backfill answers those and
 * leaves every ambiguous product for a human.
 *
 * Usage:
 *   pnpm --filter @cubby/web db:backfill-stock-tracked
 *   pnpm --filter @cubby/web db:backfill-stock-tracked -- --write --confirm-count=1743
 *
 * Three deliberate choices:
 *
 * 1. **Raw SQL, NOT the repo layer.** `Product.updatedAt` is a data-quality
 *    exception fingerprint (`data-quality.ts`), and `baseTimestamps()` wires
 *    `$onUpdate`, so any Drizzle write bumps it and silently re-opens every
 *    cleared exception on these rows with no way to tell which were legitimately
 *    stale. A plain UPDATE does not trigger `$onUpdate`. The pre-flight below
 *    asserts the cohort carries no exceptions rather than trusting that.
 *
 * 2. **The cohort is a durable predicate, not current view membership.** It is
 *    tempting to backfill exactly the products sitting in the "Not on a shelf"
 *    view today, but a food product that happens to be ledger-neutral right now
 *    is equally decided — leaving it `null` means it pops into the worklist the
 *    instant someone records a quantity.
 *
 * 3. **Products with a live inventory entry are excluded**, even food ones.
 *    Writing "no shelf claim" onto something demonstrably sitting on a shelf is
 *    a false statement; those few stay `null` so the operator decides.
 */

const COHORT = `
  SELECT id FROM "Product"
  WHERE "deletedAt" IS NULL
    AND "stockTracked" IS NULL
    AND category IN ('food','software')
    AND NOT EXISTS (
      SELECT 1 FROM "InventoryEntry" ie
      WHERE ie."productId" = "Product".id AND ie."deletedAt" IS NULL
    )
`;

const EXCEPTION_PREFLIGHT = `
  SELECT count(*)::int AS n FROM "Product"
  WHERE "deletedAt" IS NULL
    AND category IN ('food','software')
    AND jsonb_array_length("dataExceptions") > 0
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
    const { rows } = await client.query<{ id: string }>(COHORT);
    console.log(`Products awaiting stockTracked = false: ${rows.length}`);

    const { rows: exc } = await client.query<{ n: number }>(
      EXCEPTION_PREFLIGHT,
    );
    const exceptions = exc[0]?.n ?? 0;
    console.log(
      `Food/software products carrying dataExceptions: ${exceptions}`,
    );
    if (exceptions > 0) {
      throw new Error(
        `Refusing to run: ${exceptions} products in these categories carry data-quality exceptions. This script's safety argument is that no exception can be disturbed — re-check before proceeding.`,
      );
    }

    if (!write) {
      console.log(
        `\nReview only. To write:\n  pnpm --filter @cubby/web db:backfill-stock-tracked -- --write --confirm-count=${rows.length}`,
      );
      return;
    }
    if (confirmCount !== rows.length) {
      throw new Error(
        `Refusing to write: --confirm-count=${confirmArg ? confirmCount : "(absent)"} does not match the ${rows.length} rows found now. Re-review and re-run.`,
      );
    }

    const before = await client.query<{ max: Date | null }>(
      `SELECT max("updatedAt") AS max FROM "Product"`,
    );
    const maxUpdatedBefore = before.rows[0]?.max ?? null;

    const updated = await client.query(
      `UPDATE "Product" SET "stockTracked" = false WHERE id IN (${COHORT})`,
    );
    console.log(`Marked ${updated.rowCount} products.`);

    const { rows: verify } = await client.query(
      `SELECT
         (SELECT count(*)::int FROM "Product" WHERE "deletedAt" IS NULL AND "stockTracked" = false) AS untracked,
         (SELECT count(*)::int FROM "Product" WHERE "deletedAt" IS NULL AND "stockTracked" IS NULL) AS still_undecided,
         (SELECT max("updatedAt") FROM "Product") AS max_product_updated`,
    );
    console.log("\nVerification:");
    console.table(verify);

    const after = verify[0]?.max_product_updated ?? null;
    const moved =
      maxUpdatedBefore && after
        ? new Date(after).getTime() !== new Date(maxUpdatedBefore).getTime()
        : maxUpdatedBefore !== after;
    if (moved) {
      throw new Error(
        "Product.updatedAt moved during the backfill — the exception fingerprints this script exists to protect have been disturbed. Investigate.",
      );
    }
    console.log("Product.updatedAt unchanged, as intended.");

    const { rows: leftover } = await client.query<{ id: string }>(COHORT);
    if (leftover.length > 0) {
      throw new Error(
        `${leftover.length} cohort rows still undecided after the write — investigate.`,
      );
    }
    console.log("Cohort is empty. Done.");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
