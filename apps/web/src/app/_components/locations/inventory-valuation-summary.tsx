import type { LocationId } from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { formatCurrency } from "~/lib/utils";
import { useTRPC } from "~/trpc/react";
import {
  calculateInventoryValuation,
  formatPricingStatusSummary,
  type InventoryItem,
} from "./calculate-inventory-valuation";

type Variant = "compact" | "full";

interface InventoryValuationSummaryProps {
  locationId?: LocationId;
  items?: InventoryItem[];
  variant?: Variant;
  /** Hide the pricing status note (e.g., "no pricing for 2") - useful for compact cards */
  hidePricingStatus?: boolean;
  className?: string;
}

export function InventoryValuationSummary({
  locationId,
  items,
  variant = "compact",
  hidePricingStatus = false,
  className,
}: InventoryValuationSummaryProps) {
  const api = useTRPC();

  const enabled = !items && !!locationId;
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

  const pricingSummary = formatPricingStatusSummary(result.pricingStatus);

  if (variant === "compact") {
    return (
      <div className={className}>
        <div className="text-muted-foreground text-xs">
          {formatCurrency(result.totalValuation)}
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
        {formatCurrency(result.totalValuation)}
      </div>
      {pricingSummary && (
        <div className="text-muted-foreground text-xs">{pricingSummary}</div>
      )}

      {result.breakdown.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 font-medium text-muted-foreground text-xs">
            By manufacturer
          </div>
          <ul className="space-y-1">
            {result.breakdown.slice(0, 6).map((b) => (
              <li
                key={b.key}
                className="flex items-center justify-between text-sm"
              >
                <span className="truncate pr-2">{b.label}</span>
                <span className="tabular-nums">
                  {formatCurrency(b.valuation)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
