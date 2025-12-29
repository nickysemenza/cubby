import type { FC } from "react";
import type { z } from "zod";
import { BasicInfo, type BasicInfoField } from "~/components/common/basic-info";
import { MutedBox } from "~/components/layout/muted-box";
import { Button } from "~/components/ui/button";
import type { inventoryWithLocationAndProductOut } from "~/schemas/combo";
import { EntityPillLink } from "../EntityPill";
import { UnitMappingGraph } from "../units/UnitMappingGraph";
import { showAmountAndPrice } from "./format-amount";

type InventoryItem = z.infer<typeof inventoryWithLocationAndProductOut>;

interface InventoryBasicInfoProps {
  inventoryitem: InventoryItem;
  onEdit: () => void;
}

export const InventoryBasicInfo: FC<InventoryBasicInfoProps> = ({
  inventoryitem,
  onEdit,
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
      value: <EntityPillLink entity="location" data={inventoryitem.location} />,
    },
    {
      label: "Product",
      value: <EntityPillLink entity="product" data={inventoryitem.product} />,
    },
  ];

  return (
    <BasicInfo
      fields={fields}
      footer={
        <MutedBox>
          <UnitMappingGraph unitMapping={inventoryitem.product.unitMappings} />
        </MutedBox>
      }
      actions={
        <Button variant="outline" onClick={onEdit}>
          Edit Inventory Item
        </Button>
      }
    />
  );
};
