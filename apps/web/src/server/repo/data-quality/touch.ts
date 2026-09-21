import type { ProductId, PurchaseId } from "@cubby/schemas/identifiers";
import { and, inArray } from "drizzle-orm";
import { uniq } from "es-toolkit";

import type { DrizzleTransaction } from "~/server/db";
import { product, purchase } from "~/server/db/schema";
import { notDeleted } from "~/server/repo/database-helpers";

/** Keep the legacy touch hook for callers that also use it for cache freshness. */
export const touchDataQualityTargets = async (
  tx: DrizzleTransaction,
  targets: {
    productIds?: readonly ProductId[];
    purchaseIds?: readonly PurchaseId[];
  },
  at = new Date(),
): Promise<void> => {
  const productIds = uniq(targets.productIds ?? []);
  const purchaseIds = uniq(targets.purchaseIds ?? []);
  if (productIds.length > 0) {
    await tx
      .update(product)
      .set({ updatedAt: at })
      .where(and(inArray(product.id, productIds), notDeleted(product)));
  }
  if (purchaseIds.length > 0) {
    await tx
      .update(purchase)
      .set({ updatedAt: at })
      .where(and(inArray(purchase.id, purchaseIds), notDeleted(purchase)));
  }
};
