import type { ActorContext } from "@cubby/schemas/context";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type {
  AuditableEntity,
  ShortcodeEntity,
} from "@cubby/schemas/entity-manifest";
import {
  ENTITY_LABEL,
  ENTITY_NOT_FOUND_REASON,
  type EntityId,
  parseEntityId,
} from "@cubby/schemas/identifiers";
import { parseShortcodeFor, type ShortcodeFor } from "@cubby/shared";
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
import { createAppError } from "~/server/errors/app-error";
import { computeChanges, logAuditEntries } from "~/server/repo/audit-log";
import {
  buildPartialUpdateValues,
  notDeleted,
  withTransaction,
  withTransactionOn,
} from "~/server/repo/database-helpers";
import { resolveAllOrThrow } from "~/server/repo/shortcode-resolver";

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

type BulkEntity = AuditableEntity & ShortcodeEntity;
type BulkRow<T extends PatchTable> = InferSelectModel<T> & {
  id: string;
  shortcode: string;
};

/**
 * The manifest `model.bulk` patch: one complete patch over a unique selection
 * in one transaction, with per-row audit `changes` on the bulk roster.
 * `values` resolves the patch's references; `validate` sees every locked row
 * and the resolved values before the write, `afterWrite` runs after it.
 */
export async function bulkPatchEntities<
  E extends BulkEntity,
  T extends PatchTable & { shortcode: AnyColumn },
  D extends object,
>(
  db: Database,
  actor: ActorContext,
  spec: {
    entity: E;
    table: T;
    values: (
      tx: DrizzleTransaction,
      data: D,
    ) => Promise<Partial<InferSelectModel<T>>>;
    validate?: (
      tx: DrizzleTransaction,
      before: BulkRow<T>[],
      values: Partial<InferSelectModel<T>>,
    ) => Promise<void>;
    afterWrite?: (tx: DrizzleTransaction) => Promise<void>;
  },
  shortcodes: readonly string[],
  data: D,
): Promise<{
  updatedIds: EntityId<E>[];
  updatedShortcodes: ShortcodeFor<E>[];
}> {
  const label = ENTITY_LABEL[spec.entity].toLowerCase();
  if (new Set(shortcodes).size !== shortcodes.length) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `Bulk ${label} IDs must be unique.`,
    );
  }
  if (Object.values(data).every((value) => value === undefined)) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `A bulk ${label} patch must supply at least one field.`,
    );
  }
  return withTransaction(db, async (tx) => {
    const { table } = spec;
    const values = buildPartialUpdateValues(await spec.values(tx, data));
    const ids = await resolveAllOrThrow(tx, spec.entity, shortcodes);
    // SAFETY: the explicit projection of the same generic table, whose id and
    // shortcode columns PatchTable/T require.
    const before = (await tx
      .select(getTableColumns(table))
      .from(table as PgTable)
      .where(and(inArray(table.id, ids), notDeleted(table)))
      .for("update")) as BulkRow<T>[];
    if (before.length !== ids.length) {
      throw createAppError(
        ENTITY_NOT_FOUND_REASON[spec.entity],
        `One or more ${label} rows are missing.`,
      );
    }
    await spec.validate?.(tx, before, values);
    // SAFETY: `values` is a partial row of `table`, defined values only.
    const set = values as PgUpdateSetSource<T>;
    await tx
      .update(table)
      .set(set)
      .where(and(inArray(table.id, ids), notDeleted(table)));
    await spec.afterWrite?.(tx);
    // SAFETY: the manifest's bulk roster names columns of the entity's table.
    const fields = entityFieldModels[spec.entity].bulk as readonly Extract<
      keyof BulkRow<T>,
      string
    >[];
    await logAuditEntries(
      tx,
      actor,
      before.flatMap((row) => {
        const changes = computeChanges(row, { ...row, ...values }, [...fields]);
        return changes
          ? [
              {
                entityType: spec.entity,
                entityId: row.id,
                action: "update" as const,
                changes,
              },
            ]
          : [];
      }),
    );
    return {
      updatedIds: before.map((row) => parseEntityId(spec.entity, row.id)),
      updatedShortcodes: before.map((row) =>
        parseShortcodeFor(spec.entity, row.shortcode),
      ),
    };
  });
}
