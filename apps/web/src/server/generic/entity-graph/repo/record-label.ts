/** Canonical record labels shared by graph, identity and field-resolution readers. */
import type { Entity } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import {
  entityManifest,
  type ShortcodeEntity,
} from "@cubby/schemas/entity-manifest";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { is, sql, type SQL } from "drizzle-orm";
import { PgColumn } from "drizzle-orm/pg-core";

import { trimTextSql } from "~/server/db/computed/text-whitespace";
import {
  vendorAccountLabelFor,
  vendorAccountLabelSql,
} from "~/server/db/computed/vendor-account-label";
import {
  financialTransaction,
  sourceTransactionRecord,
  gardenEntry,
  run as runTable,
  meal,
  email as emailTable,
  imageProcessingJob as imageProcessingJobTable,
  plant,
  planting,
  purchase,
} from "~/server/db/retained-tables";

/**
 * Entities where the display column deliberately differs from the storage
 * column behind the entity's `titleField` (`packages/schemas/src/
 * entity-definitions/*.entity.ts` `presentation.titleField`) — each with the
 * override column (or `null`, meaning no single column at all) and a
 * one-line reason. Every entry here is a considered choice, not drift — see
 * `shortcode-resolver-labels.unit.test.ts` for the parity check this backs.
 */
export const LABEL_COLUMN_OVERRIDES = {
  sourceTransactionRecord: {
    column: sourceTransactionRecord.rawDescription,
    reason:
      "displayName falls back from source description to merchant and account; rawDescription is the best-effort stored label",
  },
  imageJob: {
    column: imageProcessingJobTable.kind,
    reason:
      "titleField (displayName) joins the kind label to the Image's filename; kind is the stored, always-present part",
  },
  email: {
    column: emailTable.subject,
    reason:
      "displayName falls back from unavailable historical subject/sender to the shortcode; subject is the best-effort stored label",
  },
  gardenEntry: {
    column: gardenEntry.kind,
    reason:
      "titleField (displayName) is a computed value with no single storage column; kind is a short, always-present label",
  },
  plant: {
    column: plant.name,
    reason:
      "titleField (displayName) appends the crop label from static data; name is the stored part",
  },
  planting: {
    column: planting.status,
    reason:
      "titleField (displayName) is a computed value with no single storage column; status is always present",
  },
  inventory: {
    column: null,
    reason:
      "titleField (displayName) is a computed relational value; inventoryEntryLabels() below builds the same 'product · location' label instead",
  },
  meal: {
    column: meal.name,
    reason:
      "titleField (displayName) is computed as name || date with no single storage column; name is the best-effort audit-label fallback (blank when the meal was never named)",
  },
  financialTransaction: {
    column: financialTransaction.merchant,
    reason:
      "titleField (displayName) is computed as merchant || rawDescription || capitalized kind with no single storage column; merchant is the best-effort audit-label fallback (null for unmatched rows)",
  },
  purchase: {
    column: purchase.displayLabel,
    reason:
      "titleField (displayName) is computed via purchaseLabel(...) with no single storage column; displayLabel is the raw nullable label column purchaseLabel is itself built from, so it's the best-effort audit-label fallback",
  },
  ledgerTransfer: {
    column: null,
    reason:
      "titleField (fromPartyName) is a read-only value joined from LedgerParty, not a physical LedgerTransfer column",
  },
  vendorAccount: {
    column: vendorAccountLabelSql,
    reason:
      "titleField (displayName) is the current '<vendor> · <member>' pair, a relational SQL expression rather than a stored column",
  },
  run: {
    column: runTable.purpose,
    reason:
      'titleField (displayName) is computed as `${vendorName ?? "Purchase agent"} · ${purpose label}` with no single storage column; purpose is the always-present best-effort audit-label fallback',
  },
} satisfies Partial<
  Record<ShortcodeEntity, { column: PgColumn | SQL | null; reason: string }>
>;

const labelOverrides = new Map(Object.entries(LABEL_COLUMN_OVERRIDES));

const recordLabelSql = (entity: Entity, alias: string) => {
  const prefix = alias ? `${alias}.` : "";
  const column = (name: string) => sql.raw(`${prefix}"${name}"`);
  switch (entity) {
    case "recipe":
    case "cookbook":
    case "ingredient":
    case "product":
    case "location":
    case "ledgerParty":
    case "financialAccount":
    case "project":
    case "task":
    case "vendor":
    case "wish":
    case "expense":
      return sql`COALESCE(${column("name")}::text, ${column("shortcode")})`;
    case "image":
      return sql`COALESCE(${column("filename")}::text, ${column("shortcode")})`;
    case "inventory":
      return sql`COALESCE((SELECT p."name" FROM "Product" p WHERE p."id" = ${column("productId")}), ${column("shortcode")})`;
    case "ledgerTransfer":
      // includes-deleted: a transfer retains the name of its historical party.
      return sql`COALESCE((SELECT p."name" FROM "LedgerParty" p WHERE p."id" = ${column("fromPartyId")}), ${column("shortcode")})`;
    // `name || date` — mirrors `displayName` in
    // `server/domains/meal/repo/helpers.ts` (an unnamed meal is identified by its
    // date, not by falling through to the shortcode).
    case "meal":
      return sql`COALESCE(NULLIF(${trimTextSql(column("name"))}, ''), ${column("date")}::text, ${column("shortcode")})`;
    // `purchaseLabel(...)`'s ladder (`apps/web/src/lib/purchase-label.ts`):
    // orderId, else vendor name + date, else vendor name; a nonblank
    // `displayLabel` is appended parenthetically without replacing the
    // identity. `vendorId` has no local column to read the name from, so it's
    // a correlated subquery against `Vendor`, same technique as the
    // planting/gardenEntry cases below.
    case "purchase":
      return sql`COALESCE(
        (CASE
          WHEN NULLIF(${trimTextSql(column("orderId"))}, '') IS NOT NULL THEN ${column("orderId")}
          WHEN ${column("date")} IS NOT NULL THEN
            COALESCE((SELECT v."name" FROM "Vendor" v WHERE v."id" = ${column("vendorId")}), 'Unknown vendor')
              || ' · ' || to_char(${column("date")}::date, 'FMMon FMDD, YYYY')
          ELSE COALESCE((SELECT v."name" FROM "Vendor" v WHERE v."id" = ${column("vendorId")}), 'Unknown vendor')
        END)
          || COALESCE(' (' || NULLIF(${trimTextSql(column("displayLabel"))}, '') || ')', ''),
        ${column("shortcode")}
      )`;
    // `merchant || rawDescription || capitalized kind` — mirrors
    // `displayName` in `server/domains/financial-transaction/repo/financial-transaction.ts`.
    case "financialTransaction":
      return sql`COALESCE(${column("merchant")}::text, ${column("rawDescription")}::text, initcap(${column("kind")}::text), ${column("shortcode")})`;
    // The plant's name; its crop label lives in static data, not SQL.
    case "plant":
      return sql`COALESCE(${column("name")}, ${column("shortcode")})`;
    // The planting's plant name — a correlated subquery against `Plant`.
    case "planting":
      return sql`COALESCE(
        (SELECT p."name" FROM "Plant" p WHERE p."id" = ${column("plantId")}),
        ${column("shortcode")}
      )`;
    // `"<Note|Harvest> · <YYYY-MM-DD> · <area name>"` — mirrors `displayName`
    // in `server/domains/garden/repo/garden.ts`. `locationId` has no local name
    // column, so the location's name is a correlated subquery against
    // `Location`.
    case "gardenEntry":
      return sql`COALESCE(
        initcap(${column("kind")}::text)
          || ' · ' || to_char(${column("observedOn")}, 'YYYY-MM-DD')
          || ' · ' || (SELECT l."name" FROM "Location" l WHERE l."id" = ${column("locationId")}),
        ${column("shortcode")}
      )`;
    case "vendorAccount":
      return sql`COALESCE(${vendorAccountLabelFor({
        vendorId: column("vendorId"),
        ledgerPartyId: column("ledgerPartyId"),
      })}, ${column("shortcode")})`;
    default: {
      const title = entitySummary[entity].titleField;
      const stored = entityFieldModels[entity].storage.find(
        (field) => field.key === title,
      );
      const override = labelOverrides.get(entity)?.column;
      const nameColumn =
        (is(override, PgColumn) ? override.name : undefined) ?? stored?.column;
      return nameColumn
        ? sql`COALESCE(${column(nameColumn)}::text, ${column("shortcode")})`
        : column("shortcode");
    }
  }
};

/** Retained evidence names tombstones without presenting them as live records. */
export const labelSql = (entity: Entity, alias: string) => {
  const label = recordLabelSql(entity, alias);
  return entityManifest[entity].softDelete
    ? sql`${label} || CASE WHEN ${sql.raw(`${alias ? `${alias}.` : ""}"deletedAt"`)} IS NOT NULL THEN ' (deleted)' ELSE '' END`
    : label;
};
