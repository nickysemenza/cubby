import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { type FC, useMemo } from "react";

import { computePerUnitPrices } from "~/lib/price-mapping-utils";
import { formatUnitPrice } from "~/lib/unit-price-format";

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
      <span className="tabular-nums" title="Derived unit price">
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
