import type { ProductId } from "@cubby/schemas/identifiers";
import { productImagePurpose } from "@cubby/schemas/image";
import {
  and,
  Column,
  eq,
  getTableName,
  is,
  isNull,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";

import type { DrizzleClient, DrizzleTransaction } from "~/server/db";
import { product } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";

/** Label membership and immutable content identify a review; processing does not. */
export const labelEvidenceRevisionSql = (
  productId: SQLWrapper,
): SQL<string | null> => {
  // Single-table SELECT projections strip Drizzle Column qualifiers even inside
  // correlated SQL. Identifiers preserve the outer table, including DQ aliases.
  const reference = is(productId, Column)
    ? sql`${sql.identifier(getTableName(productId.table))}.${sql.identifier(productId.name)}`
    : productId;
  return sql<string | null>`(
  SELECT 'label-v1:' || md5(jsonb_agg(
    jsonb_build_array(label_evidence.id, label_evidence.content_revision)
    ORDER BY label_evidence.id
  )::text)
  FROM (
    SELECT DISTINCT label_image.id,
      CASE WHEN label_image.sha256 IS NOT NULL
        THEN jsonb_build_array('sha256', label_image.sha256)
        ELSE jsonb_build_array('unknown-content', label_image.key,
          label_image.size, label_image."contentType")
      END AS content_revision
    FROM "EntityAttachment" label_attachment
    JOIN "Image" label_image ON label_image.id = label_attachment."imageId"
      AND label_image."deletedAt" IS NULL
    WHERE label_attachment."entityId" = ${reference}
      AND label_attachment."deletedAt" IS NULL
      AND label_attachment.purpose = ${productImagePurpose.enum.label}
  ) label_evidence
)`;
};

export async function loadProductLabelEvidenceRevision(
  db: DrizzleClient | DrizzleTransaction,
  productId: ProductId,
): Promise<string | null> {
  const [row] = await db
    .select({ revision: labelEvidenceRevisionSql(product.id) })
    .from(product)
    .where(and(eq(product.id, productId), isNull(product.deletedAt)))
    .limit(1);
  if (!row)
    throw createAppError(
      "PRODUCT_NOT_FOUND",
      `Product not found: ${productId}`,
    );
  return row.revision;
}

/** The caller holds the Product update lock through its Sources and field patch. */
export async function assertProductLabelReviewRevision(
  db: DrizzleClient | DrizzleTransaction,
  productId: ProductId,
  reviewedRevision: string,
): Promise<void> {
  const current = await loadProductLabelEvidenceRevision(db, productId);
  if (current === null || reviewedRevision !== current)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `Label evidence changed; read current Product labelEvidenceRevision before recording review (submitted ${reviewedRevision}, current ${current}).`,
    );
}
