import { and, eq, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { inventoryEntry, location } from "~/server/db/retained-tables";
import { entityDisplayImagePresenceSql } from "~/server/entity-kernel/repo/entity-display-image";
import { qualityCheck } from "~/server/generic/data-quality/repo/builders";
import { defineStoredEntityChecks } from "~/server/generic/data-quality/repo/stored-registry";

/** Bump when the rules or their declared scoring metadata change. */
export const INVENTORY_QUALITY_RULES_VERSION = 1;

type InventoryQualityRecord = Awaited<
  ReturnType<typeof loadInventoryQualityRecords>
>[number];

export const inventoryChecks = defineStoredEntityChecks({
  entity: "inventory",
  table: inventoryEntry,
  rulesVersion: INVENTORY_QUALITY_RULES_VERSION,
  load: loadInventoryQualityRecords,
  checks: {
    inventory_display_image: qualityCheck.hasImage,
    inventory_unknown_location: qualityCheck.observed<InventoryQualityRecord>(
      (record) => record.locationName !== "Unknown",
    ),
    // Installed fixtures are excluded from audits; only movable stock needs a
    // verification date.
    inventory_verified: qualityCheck.when(
      (record: InventoryQualityRecord) => record.placement === "stock",
      qualityCheck.required("verifiedAt"),
    ),
  },
});

async function loadInventoryQualityRecords(
  db: Database | DrizzleTransaction,
  ids: readonly string[],
) {
  if (!ids.length) return [];
  return unwrapDb(db)
    .select({
      id: inventoryEntry.id,
      shortcode: inventoryEntry.shortcode,
      placement: inventoryEntry.placement,
      verifiedAt: inventoryEntry.verifiedAt,
      locationName: location.name,
      hasDisplayImage: sql<boolean>`${entityDisplayImagePresenceSql("inventory", sql`${inventoryEntry.id}`)}`,
    })
    .from(inventoryEntry)
    .leftJoin(
      location,
      and(eq(location.id, inventoryEntry.locationId), notDeleted(location)),
    )
    .where(
      and(
        notDeleted(inventoryEntry),
        sql`${inventoryEntry.id} = ANY(${uuidArrayParam(ids)})`,
      ),
    );
}
