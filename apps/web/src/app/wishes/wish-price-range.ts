import type { WishCandidateOut } from "@cubby/schemas/wish";

export type WishPriceRange = {
  low: number;
  high: number;
  /** Candidates that carry an effective price; the rest sit outside the range. */
  pricedCount: number;
};

/**
 * The low–high span of a wish's candidate alternatives.
 *
 * Unpriced candidates are excluded rather than treated as $0 — a Tool with no
 * explicit price and no acquisition history is unknown, not free. Returns null
 * when nothing is priced, so callers render an explicit "no price" rather than
 * a fake $0 – $0 span. A single priced candidate yields `low === high`, which
 * `formatCurrencyRange` collapses back to one amount.
 *
 * The server mirrors this rule in SQL for the list footer totals (see
 * `wishPriceLow` / `wishPriceHigh` in `server/repo/wish.ts`); keep the two in
 * step.
 */
export const wishPriceRange = (
  candidates: readonly WishCandidateOut[],
): WishPriceRange | null => {
  const prices = candidates.flatMap((candidate) =>
    candidate.price === null ? [] : [candidate.price],
  );
  if (prices.length === 0) return null;
  return {
    low: Math.min(...prices),
    high: Math.max(...prices),
    pricedCount: prices.length,
  };
};
