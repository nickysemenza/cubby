import type { ActorContext } from "@cubby/schemas/context";
import type { AuditableEntity } from "@cubby/schemas/entity-manifest";
import {
  and,
  getTableColumns,
  inArray,
  type AnyColumn,
  type InferSelectModel,
} from "drizzle-orm";
import type {
  AnyPgColumn,
  PgTable,
  PgUpdateSetSource,
} from "drizzle-orm/pg-core";

import type { Database, DrizzleTransaction } from "~/server/db";
import { computeChanges, logAuditEntries } from "~/server/repo/audit-log";
import {
  buildPartialUpdateValues,
  notDeleted,
  withTransactionOn,
} from "~/server/repo/database-helpers";

type PatchTable = PgTable & {
  id: AnyPgColumn<{ data: string; notNull: true }>;
  deletedAt: AnyColumn;
};

/** Ordinary scalar patches share one transaction and return only changed rows.
 * Relationship operations and writes with domain invariants use their own
 * registered functions; they must not enter this column-only operation. */
export async function patchEntityRows<T extends PatchTable>(
  db: Database | DrizzleTransaction,
  actor: ActorContext,
  definition: {
    entity: AuditableEntity;
    table: T;
    fields: readonly Extract<keyof InferSelectModel<T>, string>[];
  },
  ids: readonly string[],
  patch: Partial<InferSelectModel<T>> & PgUpdateSetSource<T>,
): Promise<InferSelectModel<T>[]> {
  const keys = Object.entries(patch)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
  const permitted = new Set<string>(definition.fields);
  if (keys.some((key) => !permitted.has(key))) {
    throw new Error(`Undeclared ${definition.entity} patch field`);
  }
  if (ids.length === 0 || keys.length === 0) return [];

  const values = buildPartialUpdateValues(patch);
  return withTransactionOn(db, async (tx) => {
    const { table } = definition;
    // SAFETY: This is the explicit projection of the same generic table.
    // Drizzle's conditional FROM and driver result unions erase that relation.
    const result = await tx
      .select(getTableColumns(table))
      .from(table as PgTable)
      .where(and(inArray(table.id, [...ids]), notDeleted(table)));
    // SAFETY: The query projects getTableColumns(table); PatchTable requires
    // its id to be a non-null string, preserving this generic row shape.
    const before = result as (InferSelectModel<T> & { id: string })[];
    const changes = before.flatMap((row) => {
      const audit = computeChanges(row, { ...row, ...values }, [
        ...definition.fields,
      ]);
      return audit ? [{ row, audit }] : [];
    });
    if (changes.length === 0) return [];

    const updated = await tx
      .update(table)
      .set(values)
      .where(
        and(
          inArray(
            table.id,
            changes.map(({ row }) => row.id),
          ),
          notDeleted(table),
        ),
      )
      .returning(getTableColumns(table));
    // SAFETY: RETURNING projects the same table columns and non-null id as
    // the pre-update query; the driver union erases this generic relation.
    const rows = updated as (InferSelectModel<T> & { id: string })[];
    const written = new Set(rows.map((row) => row.id));
    await logAuditEntries(
      tx,
      actor,
      changes
        .filter(({ row }) => written.has(row.id))
        .map(({ row, audit }) => ({
          entityType: definition.entity,
          entityId: row.id,
          action: "update",
          changes: audit,
        })),
    );
    return rows;
  });
}
