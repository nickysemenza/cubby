import type { LocationType } from "@cubby/shared/location-type-theme";
import { and, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { locationAiDescriptionSql } from "~/server/db/computed/location-ai-description";
import { notDeleted, unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { location } from "~/server/db/retained-tables";
import { displayableImageRawSql } from "~/server/domains/image/repo/image-displayability";
import { entityDisplayImagePresenceSql } from "~/server/entity-kernel/repo/entity-display-image";
import { qualityCheck } from "~/server/generic/data-quality/repo/builders";
import { defineStoredEntityChecks } from "~/server/generic/data-quality/repo/stored-registry";

export const LOCATION_QUALITY_RULES_VERSION = 1;

type LocationQualityRecord = Awaited<
  ReturnType<typeof loadLocationQualityRecords>
>[number];
const observed = qualityCheck.observed<LocationQualityRecord>;
const when = qualityCheck.when<LocationQualityRecord>;
const furnitureLocationType: LocationType = "furniture";
const locationColumn = (column: string) =>
  sql`"Location".${sql.identifier(column)}`;

// Match PostgreSQL trim(), which removes ASCII spaces only.
const hasText = (value: string | null) =>
  value !== null && value.replace(/^ +| +$/g, "") !== "";

export const locationChecks = defineStoredEntityChecks({
  entity: "location",
  table: location,
  rulesVersion: LOCATION_QUALITY_RULES_VERSION,
  load: loadLocationQualityRecords,
  checks: {
    location_display_image: qualityCheck.hasImage,
    location_ai_description: when(
      (record) => record.hasAttachedDisplayableImage,
      observed((record) => hasText(record.aiDescription)),
    ),
    location_furniture_counted: when(
      (record) => record.type === furnitureLocationType,
      observed((record) => record.hasInventoryForProduct),
    ),
  },
});

async function loadLocationQualityRecords(
  db: Database | DrizzleTransaction,
  ids: readonly string[],
) {
  if (!ids.length) return [];
  return unwrapDb(db)
    .select({
      id: location.id,
      shortcode: location.shortcode,
      type: location.type,
      productId: location.productId,
      aiDescription: locationAiDescriptionSql(locationColumn("id")),
      hasAttachedDisplayableImage: sql<boolean>`EXISTS (
        SELECT 1 FROM "EntityAttachment" dq_location_attachment
        JOIN "Image" dq_location_image
          ON dq_location_image."id" = dq_location_attachment."imageId"
          AND dq_location_image."deletedAt" IS NULL
        WHERE dq_location_attachment."entityId" = ${locationColumn("id")}
          AND dq_location_attachment."deletedAt" IS NULL
          AND ${sql.raw(displayableImageRawSql("dq_location_image"))}
      )`,
      hasInventoryForProduct: sql<boolean>`EXISTS (
        SELECT 1 FROM "InventoryEntry" dq_location_inventory
        WHERE dq_location_inventory."productId" = ${locationColumn("productId")}
          AND dq_location_inventory."deletedAt" IS NULL
      )`,
      hasDisplayImage: sql<boolean>`${entityDisplayImagePresenceSql(
        "location",
        locationColumn("id"),
      )}`,
    })
    .from(location)
    .where(
      and(
        notDeleted(location),
        sql`${location.id} = ANY(${uuidArrayParam(ids)})`,
      ),
    );
}
