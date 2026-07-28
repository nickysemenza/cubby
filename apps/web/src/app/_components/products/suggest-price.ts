/**
 * Derive a suggested unit `price` for a product from its linked purchases.
 *
 * `price` is a *unit* value — inventory valuation is `amount.value * price` —
 * but `Purchase` has no quantity column, so `cost` is the whole-order total.
 * A single row can therefore cover several units (a real example: four Ryobi
 * LINK boxes bought as one $238.94 line), and copying that straight across
 * would overstate the product by the quantity. When the product holds more
 * than one unit we divide, and the caller shows the division so the number is
 * auditable rather than magic.
 *
 * `price` is otherwise list/replacement value in this codebase, not spend, so
 * this is deliberately a *suggestion* the user accepts — never an auto-write.
 * Cost basis stays derived from the purchase rows themselves.
 *
 * Pure and dependency-free, in a plain `.ts`: the unit-test project can't
 * import `~/`-aliased `.tsx`.
 */

/** The fields of a purchase this needs — a structural subset of `PurchaseOut`. */
export interface PriceSourcePurchase {
  cost: number | null;
  date: string | null;
  vendor: string | null;
  future: boolean;
}

export interface PriceSuggestion {
  /** What to write into `price`. */
  unitPrice: number;
  /** The purchase total this came from, before any division. */
  paid: number;
  date: string | null;
  vendor: string | null;
  /** Units the total was split across; 1 means no division happened. */
  quantity: number;
}

/**
 * @param purchases every purchase linked to the product, any order
 * @param inventoryQuantity total live units on hand, used only as the divisor
 */
export function suggestPriceFromPurchases(
  purchases: readonly PriceSourcePurchase[],
  inventoryQuantity: number,
): PriceSuggestion | null {
  // Only real money already spent. A negative cost is a disposition (sale,
  // return, write-off) and `future` is planned spend that hasn't happened —
  // neither says anything about what a unit is worth.
  const spent = purchases.filter(
    (p) => !p.future && p.cost !== null && p.cost > 0,
  );
  if (spent.length === 0) return null;

  // Most recent wins: the latest price paid is the closest thing to current
  // replacement value. Undated rows sort last rather than being dropped.
  const latest = spent.reduce((best, candidate) => {
    if (!candidate.date) return best;
    if (!best.date) return candidate;
    return candidate.date > best.date ? candidate : best;
  });

  const paid = latest.cost!;
  // Guard the divisor: a fractional or zero quantity would produce nonsense.
  const quantity =
    Number.isFinite(inventoryQuantity) && inventoryQuantity >= 1
      ? Math.round(inventoryQuantity)
      : 1;

  return {
    unitPrice: Math.round((paid / quantity) * 100) / 100,
    paid,
    date: latest.date,
    vendor: latest.vendor,
    quantity,
  };
}
