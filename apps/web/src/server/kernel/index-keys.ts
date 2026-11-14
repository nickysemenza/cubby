/**
 * Declared index keys of written rows (ADR 0029 section 5). Predicate reads
 * record index membership keys, including empty reads, so every writer of an
 * indexed table raises the keys of the rows before and after its write: plain
 * indexes from row values, joined predicates from memberships loaded from the
 * committed graph before and after the write.
 */
import { and, eq, getTableName, inArray } from "drizzle-orm";

import type { Database } from "~/server/db/database";
import { factKey } from "~/server/db/kernel-schema";
import type { RepositoryQueryClient } from "~/server/db/repository-access.boundary";

import type {
  ColumnValues,
  IndexChange,
  IndexMembership,
  Key,
  ReadIndex,
} from "./define";
import { insertFactKeys } from "./dirty";
import { indexKey } from "./keys";
import type { KernelRegistry } from "./registry";

type Q = Pick<RepositoryQueryClient, "execute" | "select" | "delete">;

const plainIndexes = (registry: KernelRegistry, table: string) =>
  (registry.indexes.get(table) ?? []).filter((index) => !index.related);

/** The plain declared index keys one row is a member of. */
export function rowIndexKeys(
  registry: KernelRegistry,
  table: string,
  row: ColumnValues,
): Key[] {
  return plainIndexes(registry, table).flatMap((index) =>
    index.values(row).map((value) => indexKey(index.name, value)),
  );
}

/** Index fact rows for written rows of an indexed table. */
export function indexFacts(
  registry: KernelRegistry,
  table: string,
  rows: readonly ColumnValues[],
): { kind: string; id: string; keys: Key[] }[] {
  if (!plainIndexes(registry, table).length) return [];
  return rows.map((row) => ({
    kind: `index:${table}`,
    id: String(row.id),
    keys: rowIndexKeys(registry, table, row),
  }));
}

/** The stored index keys of rows, before a writer changes them. */
async function indexedKeys(
  q: Q,
  registry: KernelRegistry,
  table: string,
  ids: readonly string[],
): Promise<Key[]> {
  if (!ids.length || !plainIndexes(registry, table).length) return [];
  const rows = await q
    .select({ key: factKey.key })
    .from(factKey)
    .where(
      and(
        eq(factKey.factKind, `index:${table}`),
        inArray(factKey.factId, [...ids]),
      ),
    );
  return rows.map((row) => row.key);
}

/**
 * Replace the index facts of rows just written and return their previous and
 * current keys: the previous facts stand for the rows before the write.
 */
export async function reindexRows(
  q: Q,
  registry: KernelRegistry,
  table: string,
  ids: readonly string[],
  rows: readonly ColumnValues[],
): Promise<Key[]> {
  if (!ids.length || !plainIndexes(registry, table).length) return [];
  const kind = `index:${table}`;
  const where = and(
    eq(factKey.factKind, kind),
    inArray(factKey.factId, [...ids]),
  );
  const previous = await indexedKeys(q, registry, table, ids);
  const indexed = indexFacts(registry, table, rows);
  await q.delete(factKey).where(where);
  await insertFactKeys(q, indexed);
  return [...previous, ...indexed.flatMap((row) => row.keys)];
}

/** Joined-predicate memberships of the changed rows, read from the committed graph. */
export async function relatedMemberships(
  db: Database,
  registry: KernelRegistry,
  changes: readonly IndexChange[],
): Promise<Map<ReadIndex, readonly IndexMembership[]>> {
  const result = new Map<ReadIndex, readonly IndexMembership[]>();
  if (!changes.length) return result;
  const indexes = new Map(
    [...registry.indexes.values()]
      .flat()
      .filter((index) => index.related)
      .map((index) => [index.name, index]),
  );
  for (const index of indexes.values()) {
    if (
      !changes.some((change) =>
        index.related!.tables.some(
          (table) => getTableName(table) === change.table,
        ),
      )
    )
      continue;
    result.set(index, await index.related!.load(db, changes));
  }
  return result;
}

/** Membership keys; `matching` keeps only rows inside the predicate. */
export const membershipKeys = (
  memberships: ReadonlyMap<ReadIndex, readonly IndexMembership[]>,
  matching: boolean,
): Key[] =>
  [...memberships].flatMap(([index, rows]) =>
    rows.flatMap((row) =>
      !matching || row.matches
        ? row.values.map((value) => indexKey(index.name, value))
        : [],
    ),
  );
