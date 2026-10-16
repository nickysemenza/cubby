import {
  GTIN_KIND,
  type EntityExternalIdKind,
} from "@cubby/schemas/external-id";
import type { VendorId } from "@cubby/schemas/identifiers";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  externalIdKindCheckSql,
  externalIdPrimaryCheckSql,
} from "~/server/db/external-id-schema";
import { vendor } from "~/server/db/generated/identity-storage-tables.gen";
import {
  baseTimestamps,
  softDeletedAt,
  pkUuid,
  entityRef,
  entityRefFk,
} from "~/server/db/schema-primitives";

export const externalSource = pgTable(
  "ExternalSource",
  {
    slug: text("slug").primaryKey(),
    label: text("label").notNull(),
    vendorId: uuid("vendorId")
      .$type<VendorId>()
      .references(() => vendor.id),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "ExternalSource_slug_check",
      sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`,
    ),
  ],
);

/**
 * Every identifier an outside system gives an entity: a product's ASIN or
 * barcode, a settlement's order reference, a task's Notion page. Kinds and the
 * entities they attach to are declared in `EXTERNAL_ID_KINDS`; the CHECKs are
 * rendered from it (`external-id-schema.ts`).
 *
 * An identifier names at most one live entity (`source, kind, externalId`),
 * which is what makes collision detection and statement matching exact. Rows
 * soft-delete with their entity, so a re-import after a delete can claim the
 * identifier again.
 */
export const entityExternalId = pgTable(
  "EntityExternalId",
  {
    id: pkUuid(),
    ...entityRef({ nullable: false }),
    source: text("source")
      .notNull()
      .references(() => externalSource.slug, { onUpdate: "cascade" }),
    kind: text("kind").notNull().$type<EntityExternalIdKind>(),
    externalId: text("externalId").notNull(),
    url: text("url"),
    /** The value that stands for its `(entity, source, kind)` slot; NULL for slotless kinds. */
    isPrimary: boolean("isPrimary"),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    entityRefFk("EntityExternalId_entity_fk", table),
    check("EntityExternalId_kind_check", sql.raw(externalIdKindCheckSql())),
    check(
      "EntityExternalId_primary_check",
      sql.raw(externalIdPrimaryCheckSql()),
    ),
    // Barcodes are stored in ONE canonical encoding (GTIN-14): Postgres
    // `lpad` truncates longer input, so the format is a constraint, not a
    // convention.
    check(
      "EntityExternalId_gtin_check",
      sql`${table.kind} <> ${sql.raw(`'${GTIN_KIND}'`)} OR ${table.externalId} ~ '^[0-9]{14}$'`,
    ),
    uniqueIndex("EntityExternalId_source_kind_externalId_key")
      .on(table.source, table.kind, table.externalId)
      .where(sql`${table.deletedAt} IS NULL`),
    uniqueIndex("EntityExternalId_entity_source_kind_primary_key")
      .on(table.entityId, table.source, table.kind)
      .where(sql`${table.isPrimary} AND ${table.deletedAt} IS NULL`),
    index("EntityExternalId_entityId_idx").on(table.entityId),
  ],
);
