import {
  imageDisplayabilityExclusions,
  type DisplayableFile,
} from "@cubby/schemas/image";
import { and, type SQL, type SQLWrapper, sql } from "drizzle-orm";

import { image } from "~/server/db/retained-tables";

/** Keep typed columns for Drizzle's relational-query alias rewriting. */
const displayableImagePredicate = (
  column: (field: keyof DisplayableFile) => SQLWrapper,
): SQL =>
  and(
    ...imageDisplayabilityExclusions.map(({ field, values }) => {
      const value = column(field);
      return sql`(${value} IS NULL OR ${value} NOT IN (${sql.join(
        values.map((excluded) => sql`${excluded}`),
        sql`, `,
      )}))`;
    }),
  )!;

export const displayableImageSql = (alias: string): SQL =>
  displayableImagePredicate(
    (field) => sql`${sql.identifier(alias)}.${sql.identifier(field)}`,
  );

export const displayableImageWhere = displayableImagePredicate(
  (field) => image[field],
);

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
      AND ${displayableImageSql("dimg_img")}
  )`;
