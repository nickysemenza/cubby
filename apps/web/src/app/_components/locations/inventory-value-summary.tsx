"use client";

import { useMemo, useState, useEffect } from "react";
import { useTRPC } from "~/trpc/react";
import { useQuery } from "@tanstack/react-query";
import {
  calculateInventoryValue,
  type InventoryItem,
  type InventoryValueResult,
} from "./calculate-inventory-value";

type Variant = "compact" | "full";

export interface InventoryValueSummaryProps {
  locationId?: string;
  items?: InventoryItem[];
  variant?: Variant;
  className?: string;
}

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

const emptyResult: InventoryValueResult = {
  totalValue: 0,
  breakdown: [],
  missingPriceItemNames: [],
};

export function InventoryValueSummary({
  locationId,
  items,
  variant = "compact",
  className,
}: InventoryValueSummaryProps) {
  const api = useTRPC();

  const enabled = !items && !!locationId;
  const baseOptions = api.inventoryItem.list.queryOptions({
    sort: { orderBy: "createdAt", direction: "desc" },
    // Fetch generously to cover typical cases; server supports pagination
    pagination: { pageIndex: 0, pageSize: 1000 },
    filters: {
      locationIdFilter: locationId ?? "00000000-0000-0000-0000-000000000000",
    },
  });
  const { data: fetched } = useQuery({ ...baseOptions, enabled });

  const sourceItems = useMemo(
    () => (items ?? fetched?.items ?? []) as InventoryItem[],
    [items, fetched],
  );

  // Load inventory value asynchronously
  const [result, setResult] = useState<InventoryValueResult>(emptyResult);
  useEffect(() => {
    const load = async () => {
      const value = await calculateInventoryValue(sourceItems);
      setResult(value);
    };
    void load();
  }, [sourceItems]);

  if (variant === "compact") {
    return (
      <div className={className}>
        <div className="text-muted-foreground text-xs">
          Value: {currency.format(result.totalValue)}
          {result.missingPriceItemNames.length > 0 && (
            <span className="ml-1">
              (no pricing for {result.missingPriceItemNames.length})
            </span>
          )}
        </div>
      </div>
    );
  }

  // full variant
  return (
    <div className={className}>
      <div className="mb-2 text-sm font-medium">Inventory Value</div>
      <div className="text-lg font-semibold">
        {currency.format(result.totalValue)}
      </div>
      {result.missingPriceItemNames.length > 0 && (
        <div className="text-muted-foreground text-xs">
          Missing pricing for {result.missingPriceItemNames.length} item(s)
        </div>
      )}

      {result.breakdown.length > 0 && (
        <div className="mt-3">
          <div className="text-muted-foreground mb-1 text-xs font-medium">
            By manufacturer
          </div>
          <ul className="space-y-1">
            {result.breakdown.slice(0, 6).map((b) => (
              <li
                key={b.key}
                className="flex items-center justify-between text-sm"
              >
                <span className="truncate pr-2">{b.label}</span>
                <span className="tabular-nums">{currency.format(b.value)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
