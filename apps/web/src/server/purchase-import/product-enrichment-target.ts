import { and, eq } from "drizzle-orm";

import type { DrizzleClient, DrizzleTransaction } from "~/server/db";
import { product } from "~/server/db/schema";
import { notDeleted } from "~/server/repo/database-helpers";
import { sha256Hex } from "~/server/semantic/hash";

type ProductId = typeof product.$inferSelect.id;

/**
 * The Product state a `product_enrichment` target is fingerprinted on when
 * its run starts, and rechecked before every enrichment write. One
 * implementation so callers cannot disagree on how a field serializes (a
 * timestamp read through another client shifts by the local UTC offset).
 */
export async function productEnrichmentTarget(
  executor: DrizzleClient | DrizzleTransaction,
  productId: ProductId,
  options?: { lock?: boolean },
) {
  const query = executor
    .select({
      name: product.name,
      manufacturer: product.manufacturer,
      categoryId: product.categoryId,
      model: product.model,
      updatedAt: product.updatedAt,
    })
    .from(product)
    .where(and(eq(product.id, productId), notDeleted(product)))
    .limit(1);
  const [live] = options?.lock ? await query.for("update") : await query;
  if (!live) return null;
  return {
    live,
    fingerprint: await sha256Hex(JSON.stringify({ product: live })),
  };
}
