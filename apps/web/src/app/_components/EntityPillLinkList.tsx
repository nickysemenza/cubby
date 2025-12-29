import type React from "react";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import type { LocationType } from "~/schemas/location";
import { EntityPillLink } from "./EntityPill";
import { TruncatedList } from "./TruncatedList";

// Base props shared across all entity types
type BaseProps = {
  /** Compact mode: truncates long names with max-width */
  compact?: boolean;
  /** Maximum items to show before truncating with "+N more". undefined = show all */
  maxItems?: number;
};

// Discriminated union for entity-specific list data
type EntityPillLinkListProps = BaseProps &
  (
    | {
        entity: "ingredient";
        items?: { name: string; id: string }[];
      }
    | {
        entity: "product";
        items?: { name: string; id: string; manufacturer: string }[];
      }
    | {
        entity: "recipe";
        items?: { name: string; id: string }[];
      }
    | {
        entity: "location";
        items?: { name: string; id: string; type: LocationType }[];
      }
    | {
        entity: "usda-food";
        items?: { foodInfo: { description: string | null }; fdc_id: number }[];
      }
  );

export const EntityPillLinkList: React.FC<EntityPillLinkListProps> = (
  props,
) => {
  const { items, compact, maxItems } = props;

  if (!items || items.length === 0) {
    return (
      <Empty variant="minimal" className="py-3">
        <EmptyTitle className="text-sm">None</EmptyTitle>
        <EmptyDescription className="text-xs">
          No items linked yet
        </EmptyDescription>
      </Empty>
    );
  }

  const getKey = (item: (typeof items)[number], index: number) => {
    if ("id" in item) return item.id;
    if ("fdc_id" in item) return item.fdc_id;
    return index;
  };

  const renderItem = (item: (typeof items)[number], index: number) => (
    <EntityPillLink
      key={getKey(item, index)}
      entity={props.entity}
      data={item as never}
      compact={compact}
    />
  );

  // When maxItems is set, use TruncatedList for horizontal truncation
  if (maxItems !== undefined) {
    return (
      <TruncatedList
        items={items}
        maxItems={maxItems}
        renderItem={renderItem}
        gap="gap-1"
      />
    );
  }

  // Default: show all items vertically (for detail pages)
  return (
    <div className="space-y-0.5">
      {items.map((item, index) => (
        <div key={getKey(item, index)}>{renderItem(item, index)}</div>
      ))}
    </div>
  );
};
