/**
 * Snapshot-then-diff: the pair every write that can move a Product's effective
 * price has to run.
 *
 * Historical money never lands on Product, so the effective price is rebuilt
 * from Expense on demand — which means a write to Expense can silently change
 * it. Inventory valuation is computed on read, so nothing there goes stale;
 * what does need the moved set is recipe costing. Snapshot before, diff after.
 *
 * Extracted out of `expense/crud.ts` once a second write path (the product
 * Discard) needed the same pair; a duplicated copy is how the two would drift.
 */
import type { ProductId } from "@cubby/schemas/identifiers";
import { uniq } from "es-toolkit";

import type { DrizzleTransaction } from "~/server/db";
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
 * Re-derive effective prices after a write. Returns the products that moved,
 * so the caller can recompute the recipes that cost off them.
 */
export const syncChangedEffectivePrices = async (
  tx: DrizzleTransaction,
  before: Map<ProductId, number | null>,
): Promise<ProductId[]> => {
  const ids = [...before.keys()];
  if (ids.length === 0) return [];
  const after = await loadEffectiveProductPricesById(tx, ids);
  return ids.filter((id) => before.get(id) !== after.get(id));
};
