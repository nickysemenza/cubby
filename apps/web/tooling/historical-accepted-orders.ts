import { createDatabase } from "~/server/db/database-runtime";
import { createPostgresPool } from "./postgres-pool";
import { parseArgs } from "node:util";

import { getTableName, sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/node-postgres";

import { z } from "zod";

import { Database } from "~/server/db";
import {
  expense,
  expenseAttribution,
  financialTransactionAllocation,
  importSourceOrder,
  inventoryEntry,
  purchasePaymentEvidence,
} from "~/server/db/schema";
import { relationalSchema } from "~/server/db/schema";
import { promoteHistoricalAcceptedObservation } from "~/server/domains/purchase-import/repo/reconciliation-observations";
import {
  databaseForTransaction,
  getDb,
  withTransaction,
} from "~/server/db/helpers";

import { assertMigrationBookkeeping, MIGRATIONS_FOLDER } from "./db-migrate";

const transformSummary = z.object({
  scanned: z.number().int().nonnegative(),
  alreadyKnown: z.number().int().nonnegative(),
  promoted: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
  refused: z.number().int().nonnegative(),
  financialUnchanged: z.literal(true),
});

const financialTables = {
  expense,
  expenseAttribution,
  financialTransactionAllocation,
  inventoryEntry,
  purchasePaymentEvidence,
};

const snapshotRow = z.object({
  count: z.number().int().nonnegative(),
  hash: z.string(),
});

async function financialSnapshot(db: Database) {
  const result: Record<string, z.infer<typeof snapshotRow>> = {};
  for (const [key, table] of Object.entries(financialTables)) {
    const { rows } = await getDb(db).execute<z.infer<typeof snapshotRow>>(sql`
      SELECT count(*)::int AS count,
        encode(sha256(convert_to(COALESCE(jsonb_agg(to_jsonb(${sql.identifier(getTableName(table))}) ORDER BY ${table.id}), '[]'::jsonb)::text, 'UTF8')), 'hex') AS hash
      FROM ${table}`);
    const row = rows[0];
    if (!row)
      throw new Error("Financial preservation snapshot returned no row.");
    result[key] = snapshotRow.parse(row);
  }
  return result;
}

/** Only observation/reference writes commit; any ledger or stock change rolls back the batch. */
export async function promoteHistoricalAcceptedOrders(db: Database) {
  return withTransaction(db, async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '120s'`);
    const scoped = databaseForTransaction(tx);
    const before = await financialSnapshot(scoped);
    const rows = await tx
      .select({
        id: importSourceOrder.id,
        acceptedObservationId: importSourceOrder.acceptedObservationId,
      })
      .from(importSourceOrder)
      .orderBy(importSourceOrder.id);
    const summary = {
      scanned: rows.length,
      alreadyKnown: 0,
      promoted: 0,
      unknown: 0,
      refused: 0,
      financialUnchanged: true,
    };
    for (const row of rows) {
      if (row.acceptedObservationId) {
        summary.alreadyKnown += 1;
        continue;
      }
      // A malformed legacy family cannot abort preservation of other evidence.
      // Each savepoint contains the same validated runtime promotion helper.
      try {
        const observationId = await tx.transaction((savepoint) =>
          promoteHistoricalAcceptedObservation(savepoint, row.id),
        );
        if (observationId) summary.promoted += 1;
        else summary.unknown += 1;
      } catch {
        summary.refused += 1;
      }
    }
    const after = await financialSnapshot(scoped);
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw new Error(
        "Historical evidence transform changed ledger or stock; transaction rolled back.",
      );
    return transformSummary.parse(summary);
  });
}

const CUTOVER_TAG = "0035_email_import_cutover";

async function main() {
  const { values } = parseArgs({
    options: {
      target: { type: "string" },
      apply: { type: "boolean", default: false },
    },
  });
  const url = process.env.PRODUCTION_DIRECT_DATABASE_URL;
  if (
    values.target !== "production" ||
    !url ||
    !URL.canParse(url) ||
    new URL(url).hostname.includes("-pooler")
  )
    throw new Error(
      "Use --target=production with a valid direct PRODUCTION_DIRECT_DATABASE_URL; no ambient database fallback.",
    );
  const pool = createPostgresPool({ connectionString: url, max: 1 });
  try {
    const entries = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
    const boundary = entries.findIndex((entry) => entry.name === CUTOVER_TAG);
    const applied = new Set(
      await assertMigrationBookkeeping(
        drizzle({ client: pool, paramsInErrors: true }),
        entries,
      ),
    );
    if (
      boundary < 0 ||
      applied.size !== boundary + 1 ||
      entries.slice(0, boundary + 1).some((entry) => !applied.has(entry.name))
    )
      throw new Error(
        `Historical transform requires bookkeeping exactly through ${CUTOVER_TAG}; deploy the matching server and drain old in-flight work before promotion.`,
      );
    const client = drizzle({
      client: pool,
      relations: relationalSchema,
      paramsInErrors: true,
    });
    const database = createDatabase(() => ({
      client,
      withConnection: (fn) => fn(client),
    }));
    if (!values.apply) {
      const { rows } = await client.execute<{
        total: number;
        known: number;
        retained_candidates: number;
      }>(sql`
        SELECT count(*)::int AS total,
          count(*) FILTER (WHERE "acceptedObservationId" IS NOT NULL)::int AS known,
          count(*) FILTER (WHERE "acceptedObservationId" IS NULL AND "originalOrder" IS NOT NULL)::int AS retained_candidates
        FROM ${importSourceOrder}`);
      console.log(
        JSON.stringify({
          mode: "inspect",
          counts: rows,
          validation:
            "Retained candidates still require the runtime ownership, family and extraction checks.",
        }),
      );
      return;
    }
    console.log(
      JSON.stringify({
        mode: "apply",
        summary: await promoteHistoricalAcceptedOrders(database),
      }),
    );
  } finally {
    await pool.end();
  }
}

if (import.meta.main) await main();
