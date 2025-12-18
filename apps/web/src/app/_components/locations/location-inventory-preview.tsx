"use client";

import { Package } from "lucide-react";
import { useTRPC } from "~/trpc/react";
import { useQuery } from "@tanstack/react-query";
import { type InfLocation } from "~/schemas/location";
import { ProductPillLink } from "../EntityPill";
import { InventoryValueSummary } from "./inventory-value-summary";
import { showAmountAndPrice } from "../inventory/format-amount";
import Link from "next/link";
import { Button } from "~/components/ui/button";

interface LocationInventoryPreviewProps {
  location: InfLocation;
}

export function LocationInventoryPreview({
  location,
}: LocationInventoryPreviewProps) {
  const api = useTRPC();

  const { data: inventoryData, isLoading } = useQuery(
    api.inventoryItem.list.queryOptions({
      sort: { orderBy: "createdAt", direction: "desc" },
      pagination: { pageIndex: 0, pageSize: 10 },
      filters: { locationIdFilter: location.id },
    }),
  );

  const inventoryCount = inventoryData?.meta?.totalCount ?? 0;

  if (isLoading) {
    return (
      <div className="space-y-3">
        <h4 className="text-sm font-medium">Inventory</h4>
        <div className="text-muted-foreground text-sm">Loading...</div>
      </div>
    );
  }

  if (inventoryCount === 0) {
    return (
      <div className="space-y-3">
        <h4 className="text-sm font-medium">Inventory</h4>
        <div className="text-muted-foreground text-sm">
          No inventory items at this location.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium">
          Inventory ({inventoryCount} item{inventoryCount !== 1 ? "s" : ""})
        </h4>
        <Link href={`/locations/${location.id}`}>
          <Button variant="outline" size="sm">
            View All
          </Button>
        </Link>
      </div>

      {/* Value summary */}
      <InventoryValueSummary locationId={location.id} variant="compact" />

      {/* Inventory items list */}
      <div className="space-y-2">
        {inventoryData?.items?.map((item) => (
          <div
            key={item.id}
            className="hover:bg-muted/50 flex items-center gap-3 rounded-md border p-2"
          >
            <Package size={16} className="text-muted-foreground shrink-0" />
            <div className="min-w-0 flex-1">
              <ProductPillLink product={item.product} />
            </div>
            <div className="text-muted-foreground shrink-0 text-sm">
              {showAmountAndPrice(item.amount, item.product.unitMappings)}
            </div>
          </div>
        ))}
        {inventoryCount > 10 && (
          <div className="text-muted-foreground text-center text-sm">
            +{inventoryCount - 10} more items
          </div>
        )}
      </div>
    </div>
  );
}
