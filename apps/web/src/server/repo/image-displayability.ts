import { PDF_CONTENT_TYPE } from "@cubby/schemas/image";
import { and, isNull, ne, or } from "drizzle-orm";
import { image } from "~/server/db/schema";

/** SQL counterpart of `isDisplayableImageFile` for queries and locked counts. */
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
