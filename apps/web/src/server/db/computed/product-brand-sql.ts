import type { VendorShortcode } from "@cubby/schemas/identifiers";
import { sql, type SQLWrapper } from "drizzle-orm";

import { related } from "~/server/db/helpers/related";
import { vendor } from "~/server/db/schema";

/** Brand labels and public references share one live Vendor projection. */
const brand = (brandId: SQLWrapper) =>
  related(vendor, (v) => sql`${v.id} = ${brandId}`);
export const productBrandNameSql = (brandId: SQLWrapper) =>
  brand(brandId).value<string>((v) => v.name);
export const productBrandCodeSql = (brandId: SQLWrapper) =>
  brand(brandId).value<VendorShortcode>((v) => v.shortcode);
