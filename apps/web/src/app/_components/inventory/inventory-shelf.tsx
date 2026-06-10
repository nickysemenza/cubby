import type { inventoryWithLocationAndProductOut } from "@cubby/schemas/combo";
import { Link } from "@tanstack/react-router";
import type { z } from "zod";
import { ErrorDisplay } from "~/components/feedback/error-display";
import { Image } from "~/components/ui/image";
import { Skeleton } from "~/components/ui/skeleton";
import { EntityIcon } from "~/entities/entities";
import { formatCurrency } from "~/lib/utils";

type InventoryItem = z.infer<typeof inventoryWithLocationAndProductOut>;

const GRID_CLASS =
  "grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6";

/**
 * Photo-first "shelf" view of inventory items — image-led cards with a quiet
 * caption, using the shared Image fallback (entity tile) + fade-in. The dense
 * editable table stays one toggle away; this view is for browsing.
 */
export function InventoryShelf({
  items,
  isLoading,
  error,
}: {
  items: InventoryItem[];
  isLoading?: boolean;
  error?: unknown;
}) {
  if (error) {
    return (
      <div className="py-8">
        <ErrorDisplay error={error} />
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className={GRID_CLASS}>
        {Array.from({ length: 10 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length skeleton placeholders
          <div key={i} className="overflow-hidden rounded-lg border">
            <Skeleton className="aspect-square w-full rounded-none" />
            <div className="space-y-1.5 px-2 py-2">
              <Skeleton className="h-3.5 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground text-sm">
        <EntityIcon entity="inventory" className="h-4 w-4 opacity-40" />
        Nothing here yet
      </div>
    );
  }

  return (
    <div className={GRID_CLASS}>
      {items.map((item) => {
        const image = item.product.images?.[0];
        return (
          <Link
            key={item.id}
            to="/products/$id"
            params={{ id: item.product.id }}
            className="flex flex-col overflow-hidden rounded-lg border bg-card transition-shadow duration-150 hover:shadow-[var(--shadow-warm-lg)]"
          >
            <div className="relative aspect-square w-full overflow-hidden bg-muted/20">
              <Image
                src={image?.url ?? ""}
                alt={item.product.name}
                className="absolute inset-0 h-full w-full object-cover"
                fallback={
                  <EntityIcon entity="inventory" colored className="h-6 w-6" />
                }
              />
              {(item.product.images?.length ?? 0) > 1 && (
                <div className="absolute right-1 bottom-1 rounded bg-black/60 px-1 text-2xs text-white">
                  +{(item.product.images?.length ?? 0) - 1}
                </div>
              )}
            </div>
            <div className="min-w-0 px-2 py-2">
              <div
                className="line-clamp-2 font-medium text-sm leading-tight"
                title={item.product.name}
              >
                {item.product.name}
              </div>
              <div className="mt-0.5 truncate font-mono text-muted-foreground text-xs">
                {item.amount.value} {item.amount.unit}
                {item.valuation != null &&
                  ` · ${formatCurrency(item.valuation)}`}
              </div>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
