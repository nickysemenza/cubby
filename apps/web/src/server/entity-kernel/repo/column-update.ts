import type { Entity } from "@cubby/schemas/entity";
import {
  entityFieldModels,
  type EntityFieldModel,
} from "@cubby/schemas/entity-fields";
import { isAuditableEntity } from "@cubby/schemas/entity-manifest";
import type {
  AuditableEntity,
  ShortcodeEntity,
} from "@cubby/schemas/entity-manifest";
import { getErrorMessage } from "@cubby/shared";
import { and, eq, getTableColumns, isNull, or } from "drizzle-orm";
import {
  getTableConfig,
  type PgTable,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { z } from "zod";

import { getDb, notDeleted } from "~/server/db/helpers";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { isShortcodeEntity } from "~/server/entity-kernel/repo/entity-identity";
import { findPgError } from "~/server/errors/db-errors";
import { SHORTCODE_TABLE } from "~/server/generated/shortcode-tables.gen";

import { bulkPatchEntities } from "./entity-patch";

const columnSnapshotSchema = z.record(z.string(), z.unknown());
type ColumnSnapshot = z.infer<typeof columnSnapshotSchema>;
type ColumnTable = PgTable & {
  id: AnyPgColumn<{ data: string; notNull: true }>;
  shortcode: AnyPgColumn<{ data: string; notNull: true }>;
  deletedAt: AnyPgColumn;
};

/** Dependencies of the normal writer's domain work. An opaque writer has no
 * column plan; its normal record update remains authoritative for every field. */
export type UpdatePolicy = { recordFields: readonly string[] };

export function canUpdateColumns(
  entity: Entity,
  data: unknown,
  policy: UpdatePolicy | undefined,
): entity is AuditableEntity & ShortcodeEntity {
  if (!policy || !isAuditableEntity(entity) || !isShortcodeEntity(entity))
    return false;
  const model: EntityFieldModel = entityFieldModels[entity];
  const input = z.record(z.string(), z.unknown()).parse(data);
  return Object.keys(input).every((key) => {
    const field = model.fields.find((field) => field.key === key);
    const storage = model.storage.find((column) => column.key === key);
    return (
      field !== undefined &&
      storage !== undefined &&
      storage.specialized === null &&
      !field.reference &&
      !field.collection &&
      field.kind !== "json" &&
      field.kind !== "text-array" &&
      !policy.recordFields.includes(key)
    );
  });
}

export async function updateColumns<
  E extends AuditableEntity & ShortcodeEntity,
>(ctx: EntityKernelContext, entity: E, ids: readonly string[], data: unknown) {
  const table: ColumnTable = SHORTCODE_TABLE[entity];
  const columns = getTableColumns(table);
  const input = z.record(z.string(), z.unknown()).parse(data);
  for (const key of Object.keys(input)) {
    if (!(key in columns)) throw new Error(`No ${entity} column for ${key}`);
  }
  const before: ColumnSnapshot[] = [];
  try {
    return await bulkPatchEntities(
      ctx.db,
      ctx.actorContext,
      {
        entity,
        table,
        values: async () => input,
        validate: async (_tx, rows) => {
          before.push(...rows.map((row) => columnSnapshotSchema.parse(row)));
        },
      },
      ids,
      input,
    );
  } catch (error) {
    const pg = findPgError(error);
    const index =
      pg?.code === "23505"
        ? getTableConfig(table).indexes.find(
            (index) => index.config.name === pg.constraint,
          )
        : undefined;
    if (!index) throw error;
    const keys = index.config.columns.flatMap((part) => {
      if (!("name" in part)) return [];
      const found = Object.entries(columns).find(
        ([, column]) => column.name === part.name,
      );
      return found ? [{ key: found[0], column: found[1] }] : [];
    });
    if (!keys.length || keys.length !== index.config.columns.length)
      throw error;
    const projected = before.map((row) => ({ ...row, ...input }));
    const identity = (row: ColumnSnapshot) =>
      JSON.stringify(keys.map(({ key }) => row[key]));
    // The column writer's savepoint has rolled back. Compare intended values
    // both within the selection and against surviving rows; never infer the
    // offending subset by parsing PostgreSQL's human-readable key tuple.
    const existing = (
      await getDb(ctx.db)
        .select()
        .from(table)
        .where(
          and(
            notDeleted(table),
            or(
              ...projected.map((row) =>
                and(
                  ...keys.map(({ key, column }) =>
                    row[key] === null ? isNull(column) : eq(column, row[key]),
                  ),
                ),
              ),
            ),
          ),
        )
    ).map((row) => z.record(z.string(), z.unknown()).parse(row));
    const conflicting = new Set<string>();
    for (const row of projected) {
      const peers = [...projected, ...existing].filter(
        (peer) => peer.id !== row.id && identity(peer) === identity(row),
      );
      if (peers.length) {
        conflicting.add(z.string().parse(row.shortcode));
        for (const peer of peers)
          conflicting.add(z.string().parse(peer.shortcode));
      }
    }
    if (!conflicting.size) throw error;
    throw new Error(
      `Conflicting rows: ${[...conflicting].sort().join(", ")}. ${getErrorMessage(error)}`,
      { cause: error },
    );
  }
}
