import type { VendorShortcode } from "@cubby/schemas/identifiers";
import { sql, type SQLWrapper } from "drizzle-orm";

import { notDeleted } from "~/server/db/helpers/predicates";

/** Brand labels and public references share one live Vendor projection. */
export const productBrandNameSql = (brandId: SQLWrapper) =>
  sql<
    string | null
  >`(SELECT brand."name" FROM "Vendor" brand WHERE brand."id" = ${brandId} AND ${notDeleted("brand")})`;
export const productBrandCodeSql = (brandId: SQLWrapper) =>
  sql<VendorShortcode | null>`(SELECT brand."shortcode" FROM "Vendor" brand WHERE brand."id" = ${brandId} AND ${notDeleted("brand")})`;
