import type { inventoryWithLocationAndProductOut } from "@cubby/schemas/inventory";
import type { FC } from "react";
import type { z } from "zod";
import { BasicInfo, type BasicInfoField } from "~/components/common/basic-info";
import { MutedBox } from "~/components/layout/muted-box";
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
    },
    {
      label: "Product",
      value: <EntityInlineLink entity="product" data={inventoryitem.product} />,
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
