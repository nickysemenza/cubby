/**
 * Snapshot-then-sync: the pair every write that can move a Product's effective
 * price has to run.
 *
 * Historical money never lands on Product, so the effective price is rebuilt
 * from Expense on demand — which means a write to Expense can silently change
 * it, and `InventoryEntry.valuation` (precomputed from that price) goes stale
 * without anything saying so. Snapshot before, sync after.
 *
 * Its own module rather than living in `pricing.ts` because the sync half
 * reaches into `inventory/crud.ts`, which already imports `pricing.ts` — the
 * obvious home would be an import cycle. Extracted out of `expense/crud.ts`
 * once a second write path (the product Discard) needed the same pair; a
 * duplicated copy is how the two would drift.
 */
import type { ProductId } from "@cubby/schemas/identifiers";
import { uniq } from "es-toolkit";

import type { DrizzleTransaction } from "~/server/db";
import { syncInventoryValuationsForProducts } from "~/server/repo/inventory/crud";
import { loadEffectiveProductPricesById } from "~/server/repo/product/pricing";

export const pricingProductIds = (
  values: ReadonlyArray<ProductId | null | undefined>,
) =>
  uniq(
    values.filter(
      (value): value is ProductId => value !== null && value !== undefined,
    ),
  );

/**
 * Re-derive effective prices after a write and push any change through to the
 * dependent `InventoryEntry.valuation` rows. Returns the products that moved,
 * so the caller can recompute the recipes that cost off them.
 */
export const syncChangedEffectivePrices = async (
  tx: DrizzleTransaction,
  before: Map<ProductId, number | null>,
): Promise<ProductId[]> => {
  const ids = [...before.keys()];
  if (ids.length === 0) return [];
  const after = await loadEffectiveProductPricesById(tx, ids);
  const changed = ids.filter((id) => before.get(id) !== after.get(id));
  await syncInventoryValuationsForProducts(tx, changed);
  return changed;
};
