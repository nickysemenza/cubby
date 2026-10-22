import type { ShortcodeType } from "@cubby/shared";
import {
  and,
  getTableColumns,
  inArray,
  type InferInsertModel,
  type InferSelectModel,
  isNull,
} from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import { entityIdentity } from "~/server/db/entity-identity-schema";
import type { RepositoryQueryTransaction } from "~/server/db/repository-access.boundary";
import {
  findPgError,
  type UnparsedDatabaseError,
} from "~/server/errors/db-errors";

export type EntityPayloadValues<T extends PgTable> = InferInsertModel<T> & {
  shortcode: string;
  id?: string;
  createdAt?: Date;
  deletedAt?: Date | null;
};

/** The caller owns the transaction/savepoint, including collision rollback. */
export async function insertPayloadsWithIdentities<T extends PgTable>(
  tx: RepositoryQueryTransaction,
  table: T,
  kind: ShortcodeType,
  values: readonly EntityPayloadValues<T>[],
): Promise<InferSelectModel<T>[]> {
  if (values.length === 0) return [];
  const rows = values.map((values) => ({
    ...values,
    id: values.id ?? crypto.randomUUID(),
    createdAt: values.createdAt ?? new Date(),
    deletedAt: values.deletedAt ?? null,
  }));
  await tx.insert(entityIdentity).values(
    rows.map((row) => ({
      id: row.id,
      kind,
      shortcode: row.shortcode,
      createdAt: row.createdAt,
      deletedAt: row.deletedAt,
    })),
  );
  const created = await tx
    .insert(table)
    .values(rows)
    .returning(getTableColumns(table));
  // SAFETY: The returning projection contains every column of this same T.
  return created as InferSelectModel<T>[];
}

export async function insertPayloadWithIdentity<T extends PgTable>(
  tx: RepositoryQueryTransaction,
  table: T,
  kind: ShortcodeType,
  values: EntityPayloadValues<T>,
): Promise<InferSelectModel<T>> {
  const [created] = await insertPayloadsWithIdentities(tx, table, kind, [
    values,
  ]);
  if (!created) throw new Error("Failed to insert record");
  return created;
}

/** Only shortcode collisions justify minting another code. */
export function isEntityShortcodeCollision(
  error: UnparsedDatabaseError,
  tableName: string,
): boolean {
  const pg = findPgError(error);
  if (pg?.code !== "23505") return false;
  return [`${tableName}_shortcode_unique`, "Entity_shortcode_unique"].some(
    (indexName) =>
      pg.constraint === indexName || (pg.message?.includes(indexName) ?? false),
  );
}

/** Keep the first tombstone and every redirect; identities and codes survive. */
export async function tombstoneEntityIdentities(
  tx: RepositoryQueryTransaction,
  ids: readonly string[],
  at = new Date(),
): Promise<void> {
  if (ids.length === 0) return;
  await tx
    .update(entityIdentity)
    .set({ deletedAt: at })
    .where(
      and(
        inArray(entityIdentity.id, [...ids]),
        isNull(entityIdentity.deletedAt),
      ),
    );
}
