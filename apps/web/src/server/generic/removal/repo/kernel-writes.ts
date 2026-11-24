import { getTableColumns, inArray, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { isEqual } from "es-toolkit";

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

const identityOf = (table: PgTable) =>
  Object.entries(getTableColumns(table)).find(([, column]) => column.primary);

/**
 * Report the rows a write changed, given each row's image before the write
 * (ADR 0029 section 5). Rows are compared with their committed state: a row
 * that is gone reports every column, a row that differs reports the columns
 * that differ, and an unchanged row reports nothing. `added` names rows the
 * write created or moved into the caller's predicate; they report every
 * column. A table without a single-column primary key reports nothing: no
 * reconciler reads one by row.
 */
export async function reportChangedRows(
  tx: DrizzleTransaction,
  table: PgTable,
  before: readonly ColumnValues[],
  added: readonly string[] = [],
): Promise<void> {
  const identity = identityOf(table);
  if (!identity || (!before.length && !added.length)) return;
  const [property, column] = identity;
  const ids = [
    ...new Set([...before.map((row) => String(row[property])), ...added]),
  ];
  // SAFETY: select() without a selection yields whole rows of this table.
  const current = (await tx
    .select()
    .from(table)
    .where(inArray(column, ids))) as ColumnValues[];
  const after = new Map(current.map((row) => [String(row[property]), row]));
  const prior = new Map(before.map((row) => [String(row[property]), row]));
  const all = Object.keys(getTableColumns(table));
  const columns = new Set<string>();
  const changed: string[] = [];
  const images: ColumnValues[] = [];
  for (const id of ids) {
    const was = prior.get(id);
    const now = after.get(id);
    const differing =
      !was || !now ? all : all.filter((name) => !isEqual(was[name], now[name]));
    if (!differing.length) continue;
    changed.push(id);
    images.push(was ?? now!);
    for (const name of differing) columns.add(name);
  }
  if (!changed.length) return;
  const { emitWrites } = await import("~/server/kernel/api");
  await emitWrites(databaseForTransaction(tx), {
    table,
    ids: changed,
    columns: [...columns],
    before: images,
  });
}

/**
 * Run a write that may change any row `where` selects, including rows it
 * moves into or out of the predicate, and report what it changed. The caller
 * holds the household write gate.
 */
export async function reportingWrite<T>(
  tx: DrizzleTransaction,
  table: PgTable,
  where: SQL | undefined,
  write: () => Promise<T>,
): Promise<T> {
  const identity = identityOf(table);
  // SAFETY: select() without a selection yields whole rows of this table.
  const before = (await tx.select().from(table).where(where)) as ColumnValues[];
  const result = await write();
  if (!identity) return result;
  const [property, column] = identity;
  const known = new Set(before.map((row) => String(row[property])));
  const joined = await tx.select({ id: column }).from(table).where(where);
  await reportChangedRows(
    tx,
    table,
    before,
    joined.map((row) => String(row.id)).filter((id) => !known.has(id)),
  );
  return result;
}
