import { PDF_CONTENT_TYPE } from "@cubby/schemas/image";
import { and, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { image } from "~/server/db/retained-tables";
import { entityDisplayImagePresenceSql } from "~/server/entity-kernel/repo/entity-display-image";
import { qualityCheck } from "~/server/generic/data-quality/repo/builders";
import { defineStoredEntityChecks } from "~/server/generic/data-quality/repo/stored-registry";

const IMAGE_QUALITY_RULES_VERSION = 1;

type ImageQualityRecord = Awaited<
  ReturnType<typeof loadImageQualityRecords>
>[number];
const observed = qualityCheck.observed<ImageQualityRecord>;
const when = qualityCheck.when<ImageQualityRecord>;
const imageColumn = (column: string) => sql`"Image".${sql.identifier(column)}`;

export const imageChecks = defineStoredEntityChecks({
  entity: "image",
  table: image,
  rulesVersion: IMAGE_QUALITY_RULES_VERSION,
  load: loadImageQualityRecords,
  checks: {
    image_display_image: qualityCheck.hasImage,
    image_provenance_unknown: observed((record) => record.source !== "unknown"),
    // Only the ambiguous derivation result is a defect; a blank attribution
    // has historically remained outside this check.
    image_capture_attribution: when(
      (record) => record.source === "own",
      observed((record) => record.captureAttribution !== "ambiguous"),
    ),
    image_capture_date: when(
      (record) => record.source === "own" || record.source === "screenshot",
      observed((record) => record.capturedAt !== null),
    ),
    image_dimensions: when(
      (record) => record.contentType !== PDF_CONTENT_TYPE,
      observed(
        (record) =>
          record.width !== null &&
          record.height !== null &&
          record.width > 0 &&
          record.height > 0,
      ),
    ),
    image_asset_unusable: observed((record) => !record.assetUnusable),
    image_sighting_missing: when(
      (record) => record.source === "own",
      observed((record) => record.hasLiveSighting),
    ),
  },
});

async function loadImageQualityRecords(
  db: Database | DrizzleTransaction,
  ids: readonly string[],
) {
  if (!ids.length) return [];
  return unwrapDb(db)
    .select({
      id: image.id,
      shortcode: image.shortcode,
      source: image.source,
      captureAttribution: image.captureAttribution,
      capturedAt: image.capturedAt,
      contentType: image.contentType,
      width: image.width,
      height: image.height,
      renderStatus: image.renderStatus,
      storageStatus: image.storageStatus,
      assetUnusable: sql<boolean>`(
        ${image.storageStatus} IN ('missing', 'metadata_mismatch')
        OR (
          ${image.contentType} <> ${PDF_CONTENT_TYPE}
          AND ${image.renderStatus} = 'failed'
        )
      )`,
      hasLiveSighting: sql<boolean>`EXISTS (
        SELECT 1 FROM "ImageSighting" dq_image_sighting
        WHERE dq_image_sighting."imageId" = ${imageColumn("id")}
          AND dq_image_sighting."deletedAt" IS NULL
      )`,
      hasDisplayImage: sql<boolean>`${entityDisplayImagePresenceSql(
        "image",
        imageColumn("id"),
      )}`,
    })
    .from(image)
    .where(
      and(notDeleted(image), sql`${image.id} = ANY(${uuidArrayParam(ids)})`),
    );
}
