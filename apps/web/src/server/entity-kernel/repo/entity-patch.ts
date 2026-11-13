import type { ActorContext } from "@cubby/schemas/context";
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

import {
  settleFieldEdits,
  splitFieldsValues,
} from "~/server/ai/fields/repo/field-decisions";
import { fieldsPlanOf } from "~/server/ai/fields/repo/plan";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  buildPartialUpdateValues,
  databaseForTransaction,
  notDeleted,
  withTransaction,
  withTransactionOn,
} from "~/server/db/helpers";
import { createAppError } from "~/server/errors/app-error";
import {
  computeChanges,
  logAuditEntries,
} from "~/server/generic/audit-log/repo/audit-log";
import { recordChange } from "~/server/generic/changes/repo/change";
import { resolveAllOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

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

  // `fields` columns are decisions the kernel applies per record.
  const fieldsPlan = fieldsPlanOf(definition.entity);
  const { authored: values, owned } = splitFieldsValues(
    fieldsPlan,
    buildPartialUpdateValues(patch),
  );
  const writesColumns = Object.keys(values).length > 0;
  return withTransactionOn(db, async (tx) => {
    const { table } = definition;
    const select = () =>
      // SAFETY: This is the explicit projection of the same generic table.
      // Drizzle's conditional FROM and driver result unions erase that relation.
      tx
        .select(getTableColumns(table))
        .from(table as PgTable)
        .$dynamic()
        .where(and(inArray(table.id, [...ids]), notDeleted(table)));
    // SAFETY: The query projects getTableColumns(table); PatchTable requires
    // its id to be a non-null string, preserving this generic row shape.
    const before = (await select()) as (InferSelectModel<T> & {
      id: string;
    })[];
    const changes = before.flatMap((row) => {
      const audit = computeChanges(row, { ...row, ...values }, [
        ...definition.fields,
      ]);
      const held = Object.entries(owned).some(
        ([key, value]) => String(row[key] ?? "") !== String(value ?? ""),
      );
      return audit || held ? [{ row, audit }] : [];
    });
    if (changes.length === 0) return [];

    // Widen only the builder's table metadata; the same table instance owns
    // both the patch and RETURNING projection.
    const updateTable: PgTable = table;
    const kernel = await import("~/server/kernel/api");
    if (writesColumns)
      await kernel.lockWrites(databaseForTransaction(tx), {
        table,
        ids: changes.map(({ row }) => row.id),
        columns: Object.keys(values),
      });
    const updated = writesColumns
      ? await tx
          .update(updateTable)
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
          .returning()
      : changes.map(({ row }) => row);
    // SAFETY: RETURNING projects the same table columns and non-null id as
    // the pre-update query.
    let rows = updated as (InferSelectModel<T> & { id: string })[];
    const written = new Set(rows.map((row) => row.id));
    await logAuditEntries(
      tx,
      actor,
      changes
        .filter(({ row, audit }) => audit && written.has(row.id))
        .map(({ row, audit }) => ({
          entityKind: definition.entity,
          entityId: row.id,
          action: "update",
          changes: audit ?? undefined,
        })),
    );
    if (writesColumns)
      await kernel.emitWrites(databaseForTransaction(tx), {
        table,
        ids: [...written],
        columns: Object.keys(values),
        entity: definition.entity,
      });
    if (fieldsPlan) {
      const database = databaseForTransaction(tx);
      for (const { row, audit } of changes)
        await settleFieldEdits(
          database,
          actor,
          fieldsPlan,
          row.id,
          row,
          owned,
          audit ?? undefined,
        );
      if (Object.keys(owned).length) {
        // SAFETY: as above; the kernel applied the held columns in this transaction.
        const after = (await select()) as (InferSelectModel<T> & {
          id: string;
        })[];
        rows = after.filter((row) => written.has(row.id));
      }
    }
    return rows;
  });
}

type BulkEntity = AuditableEntity & ShortcodeEntity;
type BulkRow<T extends PatchTable> = InferSelectModel<T> & {
  id: string;
  shortcode: string;
};

/**
 * The derived bulk patch: one complete patch over a unique selection
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
    // `fields` columns are decisions the kernel applies per record.
    const fieldsPlan = fieldsPlanOf(spec.entity);
    const { authored, owned } = splitFieldsValues(fieldsPlan, values);
    const kernel = await import("~/server/kernel/api");
    const database = databaseForTransaction(tx);
    // Revisions before the row locks below, the order a kernel apply takes.
    await kernel.lockWrites(database, {
      table,
      ids,
      columns: Object.keys(authored),
    });
    const queryTable: PgTable = table;
    // SAFETY: the explicit projection of the same generic table, whose id and
    // shortcode columns PatchTable/T require.
    const before = (await tx
      .select(getTableColumns(queryTable))
      .from(queryTable)
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
    const set = authored as PgUpdateSetSource<T>;
    if (Object.keys(authored).length)
      await tx
        .update(table)
        .set(set)
        .where(and(inArray(table.id, ids), notDeleted(table)));
    const fields = Object.keys(getTableColumns(table)).filter(
      (key): key is Extract<keyof BulkRow<T>, string> =>
        Object.hasOwn(authored, key),
    );
    if (fields.length)
      await kernel.emitWrites(database, {
        table,
        ids,
        columns: fields,
        entity: spec.entity,
      });
    for (const row of before)
      await settleFieldEdits(
        database,
        actor,
        fieldsPlan,
        row.id,
        row,
        owned,
        computeChanges(row, { ...row, ...authored }, [...fields]) ?? undefined,
      );
    await spec.afterWrite?.(tx);
    const auditEntries = before.flatMap((row) => {
      const changes = computeChanges(row, { ...row, ...authored }, [...fields]);
      return changes
        ? [
            {
              entityKind: spec.entity,
              entityId: row.id,
              action: "update" as const,
              changes,
            },
          ]
        : [];
    });
    await logAuditEntries(tx, actor, auditEntries);
    await recordChange(tx, { kind: "source", categories: [spec.entity] });
    return {
      updatedIds: before.map((row) => parseEntityId(spec.entity, row.id)),
      updatedShortcodes: before.map((row) =>
        parseShortcodeFor(spec.entity, row.shortcode),
      ),
    };
  });
}
