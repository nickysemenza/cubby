/** Reference policies may repoint owned foreign keys without replacing their reconciler. */
import { and, getTableColumns, inArray, isNull, type SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";

import type { Database } from "~/server/db/database";
import { withKernelApply } from "~/server/db/kernel-apply-context";
import { repositoryQueries } from "~/server/db/repository-access.boundary";

import type { ColumnValues } from "./define";
import { lockKeyRevs, markDirty } from "./dirty";
import {
  membershipKeys,
  reindexRows,
  relatedMemberships,
  rowIndexKeys,
} from "./index-keys";
import { rowKey, tableKey } from "./keys";
import { KernelContractError, idColumn } from "./reads";
import type { KernelRegistry } from "./registry";
import { wakeAfterCommit } from "./wake";

export type OwnedReferenceRepoint = {
  table: PgTable;
  column: string;
  fromIds: readonly string[];
  toId: string | null;
  /** The merge/removal policy's live-row or edge filter. */
  where?: SQL;
  liveOnly?: boolean;
};

/** Runs inside the merge/removal transaction; the kernel entry point takes the money gate. */
export async function repointOwnedReference(
  tx: Database,
  registry: KernelRegistry,
  request: OwnedReferenceRepoint,
): Promise<number> {
  const { table, column, fromIds, toId } = request;
  if (!fromIds.length) return 0;
  idColumn(table);
  const config = getTableConfig(table);
  const columns = getTableColumns(table);
  const reference = columns[column];
  const owner = [...registry.reconcilers.values()].find((reconciler) =>
    reconciler.writes.some(
      (target) => target.table === table && target.columns.includes(column),
    ),
  );
  if (
    !reference ||
    !owner ||
    !config.foreignKeys.some((fk) =>
      fk.reference().columns.some((column) => column.name === reference.name),
    )
  )
    throw new KernelContractError(
      `${config.name}.${column} is not a reconciler-owned foreign key`,
    );
  if (toId === null && reference.notNull)
    throw new KernelContractError(
      `${config.name}.${column} cannot be detached`,
    );
  const targets = owner.writes.filter((target) => target.table === table);
  const q = repositoryQueries(tx);
  const where = and(
    inArray(reference, [...fromIds]),
    request.where,
    request.liveOnly && columns.deletedAt
      ? isNull(columns.deletedAt)
      : undefined,
  );
  const before = await q.select().from(table).where(where);
  const name = config.name;
  const rowKeys = (row: ColumnValues) => [
    rowKey(name, String(row.id)),
    ...targets.flatMap((target) => target.keys?.(row) ?? []),
    ...rowIndexKeys(registry, name, row),
  ];
  const planned = before.map((row) => ({
    table: name,
    id: String(row.id),
    before: row,
    after: { ...row, [column]: toId },
  }));
  const prior = await relatedMemberships(tx, registry, planned);
  // Revisions before rows, the order a kernel apply takes them in.
  await lockKeyRevs(
    q,
    [
      ...new Set([
        tableKey(name),
        ...planned.flatMap((change) => [
          ...rowKeys(change.before),
          ...rowKeys(change.after),
        ]),
        ...membershipKeys(prior, false),
      ]),
    ].sort(),
  );
  const rows: ColumnValues[] = await withKernelApply(
    null,
    async () =>
      await repositoryQueries(tx)
        .update(table)
        .set({ [column]: toId })
        .where(where)
        .returning(),
  );
  const current = await relatedMemberships(
    tx,
    registry,
    rows.map((row) => ({
      table: name,
      id: String(row.id),
      before: before.find((entry) => entry.id === row.id) ?? null,
      after: row,
    })),
  );
  const changed = await markDirty(repositoryQueries(tx), registry, {
    keys: [
      ...new Set([
        ...(rows.length ? [tableKey(name)] : []),
        ...[...before, ...rows].flatMap(rowKeys),
        ...(await reindexRows(
          q,
          registry,
          name,
          rows.map((row) => String(row.id)),
          rows,
        )),
        ...membershipKeys(prior, true),
        ...membershipKeys(current, true),
      ]),
    ],
    reason: "reference-repoint",
    discovers: rows.flatMap((row) =>
      targets.flatMap((target) => target.discovers?.(row) ?? []),
    ),
  });
  if (changed) await wakeAfterCommit(tx);
  return rows.length;
}
