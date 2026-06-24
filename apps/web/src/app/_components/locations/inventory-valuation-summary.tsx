import type { LocationId } from "@cubby/schemas/identifiers";
import type { LocationValuation } from "@cubby/schemas/location";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Row, Stack } from "~/components/layout";
import { formatCurrency } from "~/lib/utils";
import { useTRPC } from "~/trpc/react";
import {
  calculateInventoryValuation,
  formatPricingCountsSummary,
  formatPricingStatusSummary,
  type InventoryItem,
} from "./calculate-inventory-valuation";

type Variant = "compact" | "full";

interface InventoryValuationSummaryProps {
  locationId?: LocationId;
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
  locationId,
  items,
  valuation,
  variant = "compact",
  hidePricingStatus = false,
  className,
}: InventoryValuationSummaryProps) {
  const api = useTRPC();

  // Persisted-value mode: caller passed the precomputed rollup → never fetch.
  const hasPersisted = valuation !== undefined;
  const enabled = !hasPersisted && !items && !!locationId;
  const baseOptions = api.inventory.list.queryOptions({
    sort: { orderBy: "createdAt", direction: "desc" },
    // Fetch generously to cover typical cases; server supports pagination
    pagination: { pageIndex: 0, pageSize: 1000 },
    filters: {
      locationIdFilter: locationId,
    },
  });
  const { data: fetched } = useQuery({ ...baseOptions, enabled });

  const sourceItems = useMemo(
    () => (items ?? fetched?.items ?? []) as InventoryItem[],
    [items, fetched],
  );

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
    return (
      <div className={className}>
        <div className="text-muted-foreground text-xs">
          {formatCurrency(totalValuation)}
          {!hidePricingStatus && pricingSummary && (
            <span className="ml-1">({pricingSummary})</span>
          )}
        </div>
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
        <div className="text-muted-foreground text-xs">{pricingSummary}</div>
      )}

      {result.breakdown.length > 0 && (
        <div className="mt-4">
          <div className="mb-1 font-medium text-muted-foreground text-xs">
            By manufacturer
          </div>
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
