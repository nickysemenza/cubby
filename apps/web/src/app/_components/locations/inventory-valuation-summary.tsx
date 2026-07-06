import type { LocationValuation } from "@cubby/schemas/location";
import { useMemo } from "react";
import { Row, Stack } from "~/components/layout";
import { Description } from "~/components/ui/description";
import { NoneValue } from "~/components/ui/none-value";
import { formatCurrency } from "~/lib/utils";
import {
  calculateInventoryValuation,
  formatPricingCountsSummary,
  formatPricingStatusSummary,
  type InventoryItem,
} from "./calculate-inventory-valuation";

type Variant = "compact" | "full";

interface InventoryValuationSummaryProps {
  items?: InventoryItem[];
  /**
   * Persisted per-location rollup (location.valuation). When provided, the
   * summary renders from it directly — no inventory fetch. Use this on the
   * locations list/gallery (the row already carries it) to avoid a per-row
   * `inventory.list(1000)`. `null` is treated as "not computed yet" → $0.
   */
  valuation?: LocationValuation | null;
  variant?: Variant;
  /** Hide the pricing status note (e.g., "no pricing for 2") - useful for compact cards */
  hidePricingStatus?: boolean;
  className?: string;
}

export function InventoryValuationSummary({
  items,
  valuation,
  variant = "compact",
  hidePricingStatus = false,
  className,
}: InventoryValuationSummaryProps) {
  // Persisted-value mode: caller passed the precomputed rollup → no items scan.
  const hasPersisted = valuation !== undefined;

  const sourceItems = useMemo(() => items ?? [], [items]);

  // Calculate valuation synchronously (no WASM needed - uses precomputed values)
  const result = useMemo(
    () => calculateInventoryValuation(sourceItems),
    [sourceItems],
  );

  // Persisted rollup uses direct (items at this location) to match the
  // location-filtered fetch this replaced. No manufacturer breakdown is stored,
  // so the "full" variant's breakdown only shows in the fetch path.
  const totalValuation = hasPersisted
    ? (valuation?.directValuation ?? 0)
    : result.totalValuation;
  const pricingSummary = hasPersisted
    ? formatPricingCountsSummary(valuation?.direct)
    : formatPricingStatusSummary(result.pricingStatus);

  if (variant === "compact") {
    // A $0.00 here means "empty" or "nothing priced", never a real value (the
    // persisted counts can't even distinguish a true zero) — render the muted
    // dash so real valuations stand out; the pricing note survives as a title.
    if (totalValuation === 0) {
      return (
        <div className={className} title={pricingSummary ?? undefined}>
          <NoneValue />
        </div>
      );
    }
    return (
      <div className={className}>
        <Description as="div" size="xs">
          {formatCurrency(totalValuation)}
          {!hidePricingStatus && pricingSummary && (
            <span className="ml-1">({pricingSummary})</span>
          )}
        </Description>
      </div>
    );
  }

  // full variant
  return (
    <div className={className}>
      <div className="font-semibold text-lg">
        {formatCurrency(totalValuation)}
      </div>
      {pricingSummary && (
        <Description as="div" size="xs">
          {pricingSummary}
        </Description>
      )}

      {result.breakdown.length > 0 && (
        <div className="mt-4">
          <Description as="div" size="xs" className="mb-1 font-medium">
            By manufacturer
          </Description>
          <Stack as="ul" gap="xs">
            {result.breakdown.slice(0, 6).map((b) => (
              <Row
                as="li"
                key={b.key}
                align="center"
                justify="between"
                className="text-sm"
              >
                <span className="truncate pr-2">{b.label}</span>
                <span className="tabular-nums">
                  {formatCurrency(b.valuation)}
                </span>
              </Row>
            ))}
          </Stack>
        </div>
      )}
    </div>
  );
}
