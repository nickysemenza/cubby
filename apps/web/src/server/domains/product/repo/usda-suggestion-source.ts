import type { ProductId } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  productBrandNameSql,
  productBrandCodeSql,
} from "~/server/db/computed/product-brand-sql";
import { getDb, notDeleted } from "~/server/db/helpers";
import { product } from "~/server/db/schema";
import { loadAllGtins } from "~/server/domains/product/repo/gtin";

/**
 * What identifies a Product to USDA: its name, brandName, current food
 * link, and every live barcode (primary first).
 */
export const getProductUsdaSuggestionSource = async (
  db: Database,
  id: ProductId,
) => {
  const row = await getDb(db).query.product.findFirst({
    extras: {
      brandName: productBrandNameSql(product.brandId).as("brandName"),
      brandCode: productBrandCodeSql(product.brandId).as("brandCode"),
    },
    where: and(eq(product.id, id), notDeleted(product)),
    columns: { name: true, fdc_id: true },
  });
  if (!row) return null;
  const gtins = (await loadAllGtins(db, [id])).get(id) ?? [];
  return { ...row, gtins };
};
