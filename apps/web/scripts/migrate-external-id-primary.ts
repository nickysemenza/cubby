/**
 * Hand-applied DDL for `ProductExternalId.isPrimary` (PR #829).
 *
 * `drizzle-kit push` applies index predicates as a NO-OP, so the partial unique
 * this migration creates cannot be applied by `db:push` — it would report
 * success and create nothing. Hence a script, and hence the verification pass.
 *
 * Split into two phases around the deploy, because the two code versions infer
 * DIFFERENT arbiter indexes for the same upsert:
 *
 *   deployed code:  ON CONFLICT (productId, source, kind) WHERE deletedAt IS NULL
 *   PR #829 code:   ON CONFLICT (productId, source, kind) WHERE isPrimary AND deletedAt IS NULL
 *
 * So both indexes must coexist across the deploy — drop the old one first and
 * the running code's upsert breaks; create the new one after and the freshly
 * deployed code's upsert breaks.
 *
 *   pnpm --filter @cubby/web db:migrate-external-id-primary expand    # BEFORE merging #829
 *   …merge #829, wait for the deploy…
 *   pnpm --filter @cubby/web db:migrate-external-id-primary contract  # AFTER the deploy
 *
 * Run with no argument to verify current state without writing anything.
 */
import "dotenv/config";
import { getErrorMessage } from "@cubby/shared";
import { Client } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

// Neon's `-pooler` host is PgBouncer in transaction mode, which cannot run
// `CREATE INDEX CONCURRENTLY` (it is not allowed inside a transaction block).
const directUrl = databaseUrl.replace("-pooler.", ".");

const phase = process.argv[2] ?? "verify";
if (!["verify", "expand", "contract"].includes(phase)) {
  console.error(`Unknown phase "${phase}" (verify | expand | contract).`);
  process.exit(1);
}

const client = new Client({ connectionString: directUrl });

const state = async () => {
  const { rows } = await client.query<{
    col_isprimary: boolean;
    new_idx: boolean;
    old_idx: boolean;
    stmt_idx: boolean;
    live_external_ids: number;
    parked_asins: number;
  }>(`
    SELECT
      EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'ProductExternalId' AND column_name = 'isPrimary') AS col_isprimary,
      EXISTS (SELECT 1 FROM pg_indexes
              WHERE indexname = 'ProductExternalId_product_source_kind_primary_key') AS new_idx,
      EXISTS (SELECT 1 FROM pg_indexes
              WHERE indexname = 'ProductExternalId_product_source_kind_key') AS old_idx,
      EXISTS (SELECT 1 FROM pg_indexes
              WHERE indexname = 'StatementRow_descriptor_date_amount_idx') AS stmt_idx,
      (SELECT count(*)::int FROM "ProductExternalId" WHERE "deletedAt" IS NULL) AS live_external_ids,
      (SELECT count(*)::int FROM "ProductExternalId"
        WHERE "deletedAt" IS NULL AND source = 'amazon' AND kind = 'legacy_unspecified'
          AND "externalId" ~ '^B0[0-9A-Z]{8}$') AS parked_asins
  `);
  const row = rows[0]!;
  // Counted separately, not folded into a CASE above: Postgres resolves every
  // column reference at parse time, so naming `isPrimary` in a branch that will
  // not execute still fails while the column is absent.
  const nonPrimary = row.col_isprimary
    ? (
        await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM "ProductExternalId"
            WHERE "deletedAt" IS NULL AND NOT "isPrimary"`,
        )
      ).rows[0]!.n
    : 0;
  return { ...row, non_primary: nonPrimary };
};

try {
  await client.connect();
  const { rows: whoami } = await client.query<{ db: string; host: string }>(
    "SELECT current_database() AS db, inet_server_addr()::text AS host",
  );
  console.log(`database: ${whoami[0]?.db} @ ${new URL(directUrl).host}`);
  console.log("before:", await state());

  if (phase === "expand") {
    console.log("\n-- expand --");
    // Metadata-only in PG11+: a non-volatile DEFAULT does not rewrite the table.
    // `true` is the correct value for every existing row — a slot held exactly
    // one row before this, and that row was by definition the primary.
    await client.query(
      `ALTER TABLE "ProductExternalId"
         ADD COLUMN IF NOT EXISTS "isPrimary" boolean NOT NULL DEFAULT true`,
    );
    console.log("  + ProductExternalId.isPrimary");
    await client.query(
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
         "ProductExternalId_product_source_kind_primary_key"
         ON "ProductExternalId" ("productId", source, kind)
         WHERE "isPrimary" AND "deletedAt" IS NULL`,
    );
    console.log("  + ProductExternalId_product_source_kind_primary_key");
    // From PR #828, which merged without its index; purely additive, so the
    // drift sweep has been sequential-scanning rather than failing.
    await client.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS
         "StatementRow_descriptor_date_amount_idx"
         ON "StatementRow" (source, "accountDescriptor", "statementDate", "providerAmount")`,
    );
    console.log("  + StatementRow_descriptor_date_amount_idx (PR #828)");
  }

  if (phase === "contract") {
    const before = await state();
    if (!before.new_idx) {
      console.error(
        "\nRefusing to contract: the replacement index does not exist. Run `expand` first.",
      );
      process.exit(1);
    }
    console.log("\n-- contract --");
    // Only now can a slot hold a second row, which is what demotion needs.
    await client.query(
      `DROP INDEX IF EXISTS "ProductExternalId_product_source_kind_key"`,
    );
    console.log("  - ProductExternalId_product_source_kind_key");
    // The ASINs parked in `legacy_unspecified` by hand during the 2026-08-19
    // import, because the `asin` slot was already full. Verified beforehand:
    // none of these values is taken globally, so the relabel cannot collide.
    const { rows: relabelled } = await client.query<{ externalId: string }>(
      `UPDATE "ProductExternalId"
         SET kind = 'asin', "isPrimary" = false
       WHERE "deletedAt" IS NULL AND source = 'amazon' AND kind = 'legacy_unspecified'
         AND "externalId" ~ '^B0[0-9A-Z]{8}$'
       RETURNING "externalId"`,
    );
    console.log(
      `  ~ relabelled ${relabelled.length} parked ASIN(s): ${
        relabelled.map((row) => row.externalId).join(", ") || "(none)"
      }`,
    );
  }

  if (phase !== "verify") console.log("\nafter:", await state());

  const { rows: defs } = await client.query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes
      WHERE indexname LIKE 'ProductExternalId%' ORDER BY indexname`,
  );
  console.log("\nProductExternalId indexes:");
  for (const def of defs) console.log(`  ${def.indexdef}`);
} catch (error) {
  console.error(`Migration failed: ${getErrorMessage(error)}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
