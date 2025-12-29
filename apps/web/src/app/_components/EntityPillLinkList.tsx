import type React from "react";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import type { LocationType } from "~/schemas/location";
import { EntityPillLink } from "./EntityPill";

// Base props shared across all entity types
type BaseProps = {
  /** Compact mode: truncates long names with max-width */
  compact?: boolean;
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
  const { items, compact } = props;

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

  return (
    <div className="space-y-0.5">
      {items.map((item, index) => {
        const key =
          "id" in item ? item.id : "fdc_id" in item ? item.fdc_id : index;
        return (
          <div key={key}>
            <EntityPillLink
              entity={props.entity}
              data={item as never}
              compact={compact}
            />
          </div>
        );
      })}
    </div>
  );
};
