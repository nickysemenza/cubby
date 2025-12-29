import type { FC } from "react";
import type { z } from "zod";
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
  return (
    <div className="space-y-4">
      <div className="text-lg">
        {showAmountAndPrice(
          inventoryitem.amount,
          inventoryitem.product.unitMappings,
        )}
      </div>
      <EntityPillLink entity="location" data={inventoryitem.location} />
      <EntityPillLink entity="product" data={inventoryitem.product} />
      <MutedBox>
        <UnitMappingGraph unitMapping={inventoryitem.product.unitMappings} />
      </MutedBox>
      <Button variant="outline" onClick={onEdit}>
        Edit Inventory Item
      </Button>
    </div>
  );
};
