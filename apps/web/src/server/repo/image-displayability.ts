import { PDF_CONTENT_TYPE } from "@cubby/schemas/image";
import { and, isNull, ne, or, sql } from "drizzle-orm";
import { image } from "~/server/db/schema";

/**
 * SQL counterpart of `isDisplayableImageFile` for queries and locked counts.
 *
 * The rule has three copies that must agree — this one, `displayableImageSql`
 * below, and `isDisplayableImageFile` in packages/schemas/src/image.ts. Change
 * one, change all three.
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
