import type { inventoryWithLocationAndProductOut } from "@cubby/schemas/inventory";
import type { FC } from "react";
import type { z } from "zod";
import { AuditedHint } from "~/app/inventory/session/_components/AuditedHint";
import { BasicInfo, type BasicInfoField } from "~/components/common/basic-info";
import { MutedBox } from "~/components/layout/muted-box";
import { EntityFilterLink } from "~/components/ui/entity-filter-link";
import { EntityInlineLink } from "../EntityInlineLink";
import { UnitMappingGraph } from "../units/unit-mapping-graph";
import { showAmountAndPrice } from "./format-amount";

type InventoryItem = z.infer<typeof inventoryWithLocationAndProductOut>;

interface InventoryBasicInfoProps {
  inventoryitem: InventoryItem;
}

// The edit / move / delete action cluster now lives on the Page hero plate
// (see inventory-detail.tsx) — this card is read-only.
export const InventoryBasicInfo: FC<InventoryBasicInfoProps> = ({
  inventoryitem,
}) => {
  const fields: BasicInfoField[] = [
    {
      label: "Amount",
      value: showAmountAndPrice(
        inventoryitem.amount,
        inventoryitem.product.unitMappings,
      ),
    },
    {
      label: "Location",
      value: (
        <EntityInlineLink entity="location" data={inventoryitem.location} />
      ),
      filterAction: (
        <EntityFilterLink
          to="/inventory"
          search={{ locationId: inventoryitem.location.id }}
          label={`Show all inventory in ${inventoryitem.location.name}`}
        />
      ),
    },
    {
      label: "Product",
      value: <EntityInlineLink entity="product" data={inventoryitem.product} />,
      filterAction: (
        <EntityFilterLink
          to="/inventory"
          search={{ productId: inventoryitem.product.id }}
          label={`Show all inventory entries for ${inventoryitem.product.name}`}
        />
      ),
    },
    {
      // Last deliberate recount, not `updatedAt` — inventory truth is only
      // restored by a recount, and the hint tints warning once it goes stale.
      label: "Verified",
      value: <AuditedHint at={inventoryitem.verifiedAt} label="verified" />,
    },
  ];

  return (
    <BasicInfo
      fields={fields}
      footer={
        <MutedBox>
          <UnitMappingGraph mappings={inventoryitem.product.unitMappings} />
        </MutedBox>
      }
    />
  );
};
