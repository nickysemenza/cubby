import { and, eq, type SQL, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { ListReadRow } from "~/entity/model/list-read-fields";
import { getR2PublicUrl } from "~/server/clients/r2-public-url";
import { notDeleted } from "~/server/db/helpers/predicates";
import { entityAttachment, image, vendor } from "~/server/db/schema";
import { displayableImageWhere } from "~/server/domains/image/repo/image-displayability";

const qb = new QueryBuilder();

/**
 * The storage key of a live Vendor's displayable logo. Purchase and Expense
 * reads select it as `vendorLogoKey`; `vendorLogoSummary` turns it into the
 * wire value.
 */
export const vendorLogoKeySql = (vendorId: SQL) =>
  sql<string | null>`(${qb
    .select({ key: image.key })
    .from(entityAttachment)
    .innerJoin(image, eq(image.id, entityAttachment.imageId))
    .innerJoin(vendor, eq(vendor.id, entityAttachment.entityId))
    .where(
      and(
        eq(vendor.id, vendorId),
        eq(entityAttachment.role, "logo"),
        notDeleted(entityAttachment),
        notDeleted(vendor),
        notDeleted(image),
        displayableImageWhere,
      ),
    )
    .limit(1)})`;

const logoKeyRow = z.object({ vendorLogoKey: z.string().nullish() });

export const vendorLogoSummary = (row: ListReadRow) => {
  const { vendorLogoKey } = logoKeyRow.parse(row);
  return vendorLogoKey ? { url: getR2PublicUrl(vendorLogoKey) } : null;
};
