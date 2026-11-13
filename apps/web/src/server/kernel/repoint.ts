/** Reference policies may repoint owned foreign keys without replacing their reconciler. */
import { and, getTableColumns, inArray, type SQL } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

import type { Database } from "~/server/db/database";
import { withKernelApply } from "~/server/db/kernel-apply-context";
import { repositoryQueries } from "~/server/db/repository-access.boundary";

import type { KeyedTable } from "./define";
import { markDirty } from "./dirty";
import { rowKey, tableKey } from "./keys";
import { KernelContractError } from "./reads";
import type { KernelRegistry } from "./registry";
import { wakeAfterCommit } from "./wake";

export type OwnedReferenceRepoint = {
  table: KeyedTable;
  column: string;
  fromIds: readonly string[];
  toId: string | null;
  /** The merge/removal policy's live-row or edge filter. */
  where?: SQL;
};

/** Runs inside the merge/removal transaction, which owns its write gate and policy checks. */
export async function repointOwnedReference(
  tx: Database,
  registry: KernelRegistry,
  request: OwnedReferenceRepoint,
): Promise<number> {
  const { table, column, fromIds, toId } = request;
  if (!fromIds.length) return 0;
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
  const before = await q
    .select()
    .from(table)
    .where(and(inArray(reference, [...fromIds]), request.where));
  const rows = await withKernelApply(
    null,
    async () =>
      await repositoryQueries(tx)
        .update(table)
        .set({ [column]: toId })
        .where(and(inArray(reference, [...fromIds]), request.where))
        .returning(),
  );
  const changed = await markDirty(repositoryQueries(tx), registry, {
    keys: [
      ...(rows.length ? [tableKey(config.name)] : []),
      ...[...before, ...rows].flatMap((row) => [
        rowKey(config.name, String(row.id)),
        ...targets.flatMap((target) => target.keys?.(row) ?? []),
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
