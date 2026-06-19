import type { inventoryWithLocationAndProductOut } from "@cubby/schemas/combo";
import { ArrowRightLeft } from "lucide-react";
import type { FC } from "react";
import type { z } from "zod";
import { BasicInfo, type BasicInfoField } from "~/components/common/basic-info";
import { MutedBox } from "~/components/layout/muted-box";
import { Button } from "~/components/ui/button";
import { EntityPillLink } from "../EntityPill";
import { UnitMappingGraph } from "../units/unit-mapping-graph";
import { showAmountAndPrice } from "./format-amount";

type InventoryItem = z.infer<typeof inventoryWithLocationAndProductOut>;

interface InventoryBasicInfoProps {
  inventoryitem: InventoryItem;
  onEdit: () => void;
  onMove?: () => void;
  DeleteButton?: FC<{ size?: "sm" | "default" }>;
}

export const InventoryBasicInfo: FC<InventoryBasicInfoProps> = ({
  inventoryitem,
  onEdit,
  onMove,
  DeleteButton,
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
          <UnitMappingGraph mappings={inventoryitem.product.unitMappings} />
        </MutedBox>
      }
      actions={
        <div className="flex gap-2">
          <Button variant="outline" onClick={onEdit}>
            Edit Inventory Item
          </Button>
          {onMove && (
            <Button variant="outline" onClick={onMove}>
              <ArrowRightLeft className="mr-2 h-4 w-4" />
              Move to...
            </Button>
          )}
          {DeleteButton && <DeleteButton />}
        </div>
      }
    />
  );
};
