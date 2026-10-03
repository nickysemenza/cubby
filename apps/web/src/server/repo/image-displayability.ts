import { PDF_CONTENT_TYPE } from "@cubby/schemas/image";
import {
  and,
  isNull,
  ne,
  or,
  type SQL,
  type SQLWrapper,
  sql,
} from "drizzle-orm";

import { image } from "~/server/db/schema";

/**
 * SQL counterpart of `isDisplayableImageFile` for queries and locked counts.
 *
 * The rule has FOUR copies that must agree — this one, `displayableImageSql`
 * and `displayableImageRawSql` below, and `isDisplayableImageFile` in
 * packages/schemas/src/image.ts. Change one, change all four.
 */
export const displayableImageWhere = and(
  ne(image.contentType, PDF_CONTENT_TYPE),
  or(isNull(image.renderStatus), ne(image.renderStatus, "failed")),
  or(
    isNull(image.storageStatus),
    and(
      ne(image.storageStatus, "missing"),
      ne(image.storageStatus, "metadata_mismatch"),
    ),
  ),
);

/**
 * Raw-SQL twin of {@link displayableImageWhere}, for hand-written queries that
 * alias the Image table.
 *
 * Drizzle renders `displayableImageWhere` against the unaliased `"Image"`, which
 * silently fails to constrain a query that joins it as `i` — so a hand-written
 * UNION needs this form, parameterized by the alias it actually used.
 */
export const displayableImageSql = (alias: string) =>
  sql`${sql.identifier(alias)}."contentType" <> ${PDF_CONTENT_TYPE}
    AND (${sql.identifier(alias)}."renderStatus" IS NULL OR ${sql.identifier(alias)}."renderStatus" <> 'failed')
    AND (${sql.identifier(alias)}."storageStatus" IS NULL
         OR ${sql.identifier(alias)}."storageStatus" NOT IN ('missing', 'metadata_mismatch'))`;

/**
 * Plain-string twin of {@link displayableImageSql}, for the raw-string builders
 * in data-quality.ts that concatenate SQL text before handing it to `sql.raw`.
 *
 * Those builders cannot take a Drizzle `SQL` object: `sql.raw` wants text, and
 * `displayableImageSql` carries a bind parameter for the content type. The
 * literal below is interpolated from the same `PDF_CONTENT_TYPE` constant so
 * the VALUE still has one source of truth even though the SHAPE is duplicated.
 */
export const displayableImageRawSql = (alias: string): string =>
  `"${alias}"."contentType" <> '${PDF_CONTENT_TYPE}'
    AND ("${alias}"."renderStatus" IS NULL OR "${alias}"."renderStatus" <> 'failed')
    AND ("${alias}"."storageStatus" IS NULL
         OR "${alias}"."storageStatus" NOT IN ('missing', 'metadata_mismatch'))`;

/**
 * Whether a Product has a photo the thumbnail cell would render: a live
 * attachment to a live, displayable Image, excluding `label` attachments (a
 * photo of packaging text, not a representative picture). The one definition
 * behind the `product_image` data-quality check, the image presence filter,
 * the no-image backfill selections, and the UPC-gap detector — hand-copied
 * variants omitted the Image soft-delete or the `label` exclusion, so a
 * product could be "imageless" in one worklist and "imaged" in another.
 */
export const productHasDisplayableImageSql = (productId: SQLWrapper): SQL =>
  sql`EXISTS (
    SELECT 1 FROM "EntityAttachment" dimg_att
    JOIN "Image" dimg_img
      ON dimg_img."id" = dimg_att."imageId" AND dimg_img."deletedAt" IS NULL
    WHERE dimg_att."entityId" = ${productId}
      AND dimg_att."deletedAt" IS NULL
      AND dimg_att."purpose" IS DISTINCT FROM 'label'
      AND ${sql.raw(displayableImageRawSql("dimg_img"))}
  )`;
