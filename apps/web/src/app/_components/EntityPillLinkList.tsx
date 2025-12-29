import type React from "react";
import type { LocationType } from "~/schemas/location";
import { EntityPillLink } from "./EntityPill";
import { NoneState } from "./NoneState";

// Discriminated union for entity-specific list data
type EntityPillLinkListProps =
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
    };

export const EntityPillLinkList: React.FC<EntityPillLinkListProps> = (
  props,
) => {
  const { items } = props;

  if (!items || items.length === 0) {
    return <NoneState />;
  }

  return (
    <div className="space-y-0.5">
      {items.map((item, index) => {
        const key =
          "id" in item ? item.id : "fdc_id" in item ? item.fdc_id : index;
        return (
          <div key={key}>
            <EntityPillLink entity={props.entity} data={item as never} />
          </div>
        );
      })}
    </div>
  );
};
