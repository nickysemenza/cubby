import { and, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { vendor } from "~/server/db/retained-tables";
import { displayableImageRawSql } from "~/server/domains/image/repo/image-displayability";
import { entityDisplayImagePresenceSql } from "~/server/entity-kernel/repo/entity-display-image";
import { qualityCheck } from "~/server/generic/data-quality/repo/builders";
import { defineStoredEntityChecks } from "~/server/generic/data-quality/repo/stored-registry";

export const VENDOR_QUALITY_RULES_VERSION = 1;

type VendorQualityRecord = Awaited<
  ReturnType<typeof loadVendorQualityRecords>
>[number];
const observed = qualityCheck.observed<VendorQualityRecord>;
const when = qualityCheck.when<VendorQualityRecord>;
const vendorColumn = (column: string) =>
  sql`"Vendor".${sql.identifier(column)}`;

// Match PostgreSQL trim(), which removes ASCII spaces only.
const hasText = (value: string | null) =>
  value !== null && value.replace(/^ +| +$/g, "") !== "";

export const vendorChecks = defineStoredEntityChecks({
  entity: "vendor",
  table: vendor,
  rulesVersion: VENDOR_QUALITY_RULES_VERSION,
  load: loadVendorQualityRecords,
  checks: {
    vendor_display_image: qualityCheck.hasImage,
    vendor_order_evidence: when(
      (record) => record.hasLivePurchase,
      observed((record) => record.orderEvidence !== null),
    ),
    vendor_order_evidence_conflict: observed(
      (record) =>
        !(
          record.orderEvidence === "not_expected" &&
          record.itemizationExpectation === "required"
        ),
    ),
    vendor_logo: when(
      (record) => record.systemKey === null,
      observed((record) => record.hasDisplayableLogo),
    ),
    vendor_website: when(
      (record) => record.systemKey === null,
      observed((record) => hasText(record.website)),
    ),
  },
});

async function loadVendorQualityRecords(
  db: Database | DrizzleTransaction,
  ids: readonly string[],
) {
  if (!ids.length) return [];
  return unwrapDb(db)
    .select({
      id: vendor.id,
      shortcode: vendor.shortcode,
      orderEvidence: vendor.orderEvidence,
      itemizationExpectation: vendor.itemizationExpectation,
      systemKey: vendor.systemKey,
      website: vendor.website,
      hasLivePurchase: sql<boolean>`EXISTS (
        SELECT 1 FROM "Purchase" dq_vendor_purchase
        WHERE dq_vendor_purchase."vendorId" = ${vendorColumn("id")}
          AND dq_vendor_purchase."deletedAt" IS NULL
      )`,
      hasDisplayableLogo: sql<boolean>`EXISTS (
        SELECT 1 FROM "EntityAttachment" dq_vendor_attachment
        JOIN "Image" dq_vendor_image
          ON dq_vendor_image."id" = dq_vendor_attachment."imageId"
        WHERE dq_vendor_attachment."entityId" = ${vendorColumn("id")}
          AND dq_vendor_attachment."role" = 'logo'
          AND dq_vendor_attachment."deletedAt" IS NULL
          AND dq_vendor_image."deletedAt" IS NULL
          AND ${sql.raw(displayableImageRawSql("dq_vendor_image"))}
      )`,
      hasDisplayImage: sql<boolean>`${entityDisplayImagePresenceSql(
        "vendor",
        vendorColumn("id"),
      )}`,
    })
    .from(vendor)
    .where(
      and(notDeleted(vendor), sql`${vendor.id} = ANY(${uuidArrayParam(ids)})`),
    );
}
