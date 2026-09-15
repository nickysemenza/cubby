import type { inventoryWithLocationAndProductOut } from "@cubby/schemas/inventory";
import type { FC } from "react";
import type { z } from "zod";

import { AuditedHint } from "~/app/inventory/session/_components/AuditedHint";
import { MutedBox } from "~/components/layout/muted-box";
import { EntityFilterLink } from "~/components/ui/entity-filter-link";
import { EntityBasicInfo } from "~/entities/entity-display";

import { EntityInlineLink } from "../EntityInlineLink";
import { UnitMappingGraph } from "../units/unit-mapping-graph";
import { showAmountAndPrice } from "./format-amount";
import { InventoryPlacementSuggestion } from "./inventory-placement-suggestion";

type InventoryItem = z.infer<typeof inventoryWithLocationAndProductOut>;

interface InventoryBasicInfoProps {
  inventoryitem: InventoryItem;
}

// The edit / move / delete action cluster now lives on the Page hero plate
// (see inventory-detail.tsx) — this card is read-only.
export const InventoryBasicInfo: FC<InventoryBasicInfoProps> = ({
  inventoryitem,
}) => {
  return (
    <EntityBasicInfo
      entity="inventory"
      record={inventoryitem}
      overrides={{
        amount: (record) => ({
          value: showAmountAndPrice(record.amount, record.product.unitMappings),
        }),
        locationId: (record) => ({
          value: (
            <div className="min-w-0 space-y-2">
              <EntityInlineLink
                displayImage={undefined}
                entity="location"
                data={record.location}
              />
              <InventoryPlacementSuggestion inventoryitem={record} />
            </div>
          ),
          filterAction: (
            <EntityFilterLink
              to="/inventory"
              search={{ locationId: record.location.id }}
              label={`Show all inventory in ${record.location.name}`}
            />
          ),
        }),
        productId: (record) => ({
          value: (
            <EntityInlineLink
              displayImage={undefined}
              entity="product"
              data={record.product}
            />
          ),
          filterAction: (
            <EntityFilterLink
              to="/inventory"
              search={{ productId: record.product.id }}
              label={`Show all inventory entries for ${record.product.name}`}
            />
          ),
        }),
        verifiedAt: (record) => ({
          // Last deliberate recount, not `updatedAt` — inventory truth is only
          // restored by a recount, and the hint tints warning once it goes stale.
          value: <AuditedHint at={record.verifiedAt} label="verified" />,
        }),
      }}
      footer={
        <MutedBox>
          <UnitMappingGraph mappings={inventoryitem.product.unitMappings} />
        </MutedBox>
      }
    />
  );
};
