import type { EntityQualityCheckState } from "@cubby/schemas/data-quality-shape";
import type { Entity } from "@cubby/schemas/entity";
import { and, sql } from "drizzle-orm";
import type { PgTable, SelectedFields, AnyPgColumn } from "drizzle-orm/pg-core";

import { hasText } from "~/lib/text-whitespace";
import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { entityDisplayImagePresenceSql } from "~/server/entity-kernel/repo/entity-display-image";

type CheckState = Exclude<EntityQualityCheckState, "waived">;
export type QualityCheck<Record> = (record: Record) => CheckState;

/** Shared predicates consume a batch-loaded record and never perform I/O. */
const observed =
  <R>(predicate: (record: R) => boolean): QualityCheck<R> =>
  (record) =>
    predicate(record) ? "pass" : "gap";

const required = <R>(field: keyof R): QualityCheck<R> =>
  observed((record) => {
    const value = record[field];
    return (
      value !== null &&
      value !== undefined &&
      (typeof value !== "string" || hasText(value))
    );
  });

const hasRelated = <R>(
  read: (record: R) => readonly unknown[],
): QualityCheck<R> => observed((record) => read(record).length > 0);

const hasImage = observed<{ hasDisplayImage: boolean }>(
  (record) => record.hasDisplayImage,
);

const when =
  <R>(
    applies: (record: R) => boolean,
    check: QualityCheck<R>,
  ): QualityCheck<R> =>
  (record) =>
    applies(record) ? check(record) : "not_applicable";

/** Ordinary check loaders share identity, liveness, bounded IDs and image presence.
 * Entity-specific joins and aggregate loaders retain their own query. */
const records =
  <
    T extends PgTable & {
      id: AnyPgColumn<{ data: string; notNull: true }>;
      shortcode: AnyPgColumn<{ data: string; notNull: true }>;
    },
    C extends SelectedFields,
  >(
    entity: Entity,
    table: T,
    columns: C,
  ) =>
  async (db: Database | DrizzleTransaction, ids: readonly string[]) => {
    if (!ids.length) return [];
    const source: PgTable = table;
    return unwrapDb(db)
      .select({
        ...columns,
        id: table.id,
        shortcode: table.shortcode,
        hasDisplayImage: sql<boolean>`${entityDisplayImagePresenceSql(entity, sql`${table.id}`)}`,
      })
      .from(source)
      .where(
        and(notDeleted(table), sql`${table.id} = ANY(${uuidArrayParam(ids)})`),
      );
  };

/** Shared check construction API for entity ports. */
export const qualityCheck = {
  required,
  hasRelated,
  hasImage,
  observed,
  when,
  records,
};
