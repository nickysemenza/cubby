import type { ReactNode } from "react";
import { Badge } from "~/components/ui/badge";
import { NoneValue } from "~/components/ui/none-value";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";

interface TruncatedListProps<T> {
  items: T[];
  /** Maximum items to show before truncating. undefined = show all */
  maxItems?: number;
  /** Render function for each visible item */
  renderItem: (item: T, index: number) => ReactNode;
  /** Render function for items in the overflow tooltip. Defaults to renderItem */
  renderOverflowItem?: (item: T, index: number) => ReactNode;
  /** Custom className for the container */
  className?: string;
  /** Gap between items. Defaults to "gap-1" */
  gap?: string;
  /** Layout direction. Defaults to "horizontal" */
  direction?: "horizontal" | "vertical";
}

/**
 * Renders a list of items with optional truncation.
 * When maxItems is set and exceeded, shows visible items + a "+N more" badge
 * with a tooltip listing the remaining items.
 */
export function TruncatedList<T>({
  items,
  maxItems,
  renderItem,
  renderOverflowItem,
  className,
  gap = "gap-1",
  direction = "horizontal",
}: TruncatedListProps<T>) {
  if (!items || items.length === 0) {
    return <NoneValue />;
  }

  const shouldTruncate = maxItems !== undefined && items.length > maxItems;
  const visibleItems = shouldTruncate ? items.slice(0, maxItems) : items;
  const hiddenItems = shouldTruncate ? items.slice(maxItems) : [];
  const hiddenCount = hiddenItems.length;

  const flexDirection = direction === "vertical" ? "flex-col" : "flex-row";
  const containerClass = `flex ${flexDirection} items-center ${gap} ${className ?? ""}`;

  return (
    <div className={containerClass}>
      {visibleItems.map((item, index) => renderItem(item, index))}
      {hiddenCount > 0 && (
        <Popover>
          <PopoverTrigger openOnHover closeDelay={150}>
            <Badge
              variant="secondary"
              className="h-4 cursor-default px-1 font-normal text-2xs"
            >
              +{hiddenCount}
            </Badge>
          </PopoverTrigger>
          <PopoverContent side="bottom" className="w-auto max-w-xs p-2">
            <div className="flex flex-col gap-1">
              {hiddenItems.map((item, index) =>
                (renderOverflowItem ?? renderItem)(item, index + maxItems!),
              )}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
