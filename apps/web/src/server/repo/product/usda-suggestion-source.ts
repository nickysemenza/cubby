import type { ProductId } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { product } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";

import { loadAllGtins } from "./gtin";

/**
 * What identifies a Product to USDA: its name, manufacturer, current food
 * link, and every live barcode (primary first).
 */
export const getProductUsdaSuggestionSource = async (
  db: Database,
  id: ProductId,
) => {
  const row = await getDb(db).query.product.findFirst({
    where: and(eq(product.id, id), notDeleted(product)),
    columns: { name: true, manufacturer: true, fdc_id: true },
  });
  if (!row) return null;
  const gtins = (await loadAllGtins(db, [id])).get(id) ?? [];
  return { ...row, gtins };
};
