import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { type FC, useMemo } from "react";

import { computePerUnitPrices } from "~/lib/price-mapping-utils";
import { formatCurrency } from "~/lib/utils";

/**
 * A comparable unit price needs more precision than money usually does: onions
 * land near $0.003/g, and the 2-decimal default renders that as $0.00 — worse
 * than showing nothing, because it reads as free.
 *
 * So the precision follows the magnitude, and only far enough to carry two
 * significant digits. Sub-cent values are the common case here, not an edge one.
 */
export const formatUnitPrice = (price: number): string => {
  if (price === 0) return formatCurrency(0);
  const magnitude = Math.abs(price);
  const decimals = magnitude >= 1 ? 2 : magnitude >= 0.01 ? 3 : 5;
  return formatCurrency(price, decimals);
};

/**
 * The derived per-unit price for one product's conversion graph.
 *
 * Renders nothing when the graph has no path to money — a product with no price,
 * or a measure the graph can't reach. Blank is the honest output there; the
 * alternative is a confident-looking wrong number.
 */
export const UnitPriceLine: FC<{
  mappings?: UnitMapping[];
  prices?: ReturnType<typeof computePerUnitPrices> | null;
  /** Compact hides the label and the per-gram figure (list/table cells). */
  compact?: boolean;
}> = ({ mappings = [], prices: suppliedPrices, compact = false }) => {
  const computedPrices = useMemo(
    () => computePerUnitPrices(mappings),
    [mappings],
  );
  const prices = suppliedPrices ?? computedPrices;
  if (!prices.natural) return null;

  const natural = `${formatUnitPrice(prices.natural.price)}/${prices.natural.unit}`;
  // Per-gram is the cross-product comparator, so it is worth its own figure —
  // but it is redundant when grams ARE the natural basis.
  const perGram =
    prices.perGram !== null && prices.natural.unit !== "g"
      ? `${formatUnitPrice(prices.perGram)}/g`
      : null;

  if (compact) {
    return (
      <span
        className="font-mono text-xs tabular-nums"
        title="Derived unit price"
      >
        {natural}
      </span>
    );
  }

  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
      <span className="eyebrow">Unit price</span>
      <span className="font-mono text-sm text-primary tabular-nums">
        {natural}
      </span>
      {perGram && (
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {perGram}
        </span>
      )}
    </div>
  );
};
