import { getTableColumns } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import type { DrizzleTransaction } from "~/server/db";
import { databaseForTransaction } from "~/server/db/helpers";
import type { ColumnValues } from "~/server/kernel/define";

/**
 * The household write gate, before a removal, detach or repoint locks its
 * first row (ADR 0029 section 6). Re-entrant; refuses a transaction that
 * already holds a lock without it.
 */
export async function enterRemovalGate(tx: DrizzleTransaction): Promise<void> {
  const { enterHouseholdGate } = await import("~/server/kernel/api");
  await enterHouseholdGate(databaseForTransaction(tx));
}

/**
 * Report identity rows a tombstone or merge redirect changed: a saved
 * reference resolved through them may now name another record or none. The
 * removal and merge paths hold the household write gate.
 */
export async function reportIdentityWrites(
  tx: DrizzleTransaction,
  rows: readonly { id: string; kind: string; shortcode: string | null }[],
): Promise<void> {
  if (!rows.length) return;
  const [{ identityKeys }, { raiseKeys }] = await Promise.all([
    import("~/server/kernel/identity-keys"),
    import("~/server/kernel/api"),
  ]);
  const keys = identityKeys(rows);
  if (keys.length) await raiseKeys(tx, keys, "identity");
}

/**
 * Report rows a removal, detach or repoint wrote, with their values before
 * the write, the way an entity writer reports its own (ADR 0029 section 5):
 * the kernel raises the row, table and declared column keys a reconciler
 * reads, re-keys evidence, and raises read-index memberships before and
 * after. A table no reconciler reads emits nothing.
 */
export async function reportRowWrites(
  tx: DrizzleTransaction,
  table: PgTable,
  before: readonly ColumnValues[],
  columns: readonly string[],
): Promise<void> {
  if (!before.length) return;
  const identity = Object.entries(getTableColumns(table)).find(
    ([, column]) => column.primary,
  )?.[0];
  const { emitWrites } = await import("~/server/kernel/api");
  await emitWrites(databaseForTransaction(tx), {
    table,
    ids: identity ? before.map((row) => String(row[identity])) : [],
    columns,
    before,
  });
}
