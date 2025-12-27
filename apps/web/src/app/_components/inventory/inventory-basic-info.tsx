"use client";

import type { FC } from "react";
import type { z } from "zod";
import { Button } from "~/components/ui/button";
import type { inventoryWithLocationAndProductOut } from "~/schemas/combo";
import { LocationPillLink, ProductPillLink } from "../EntityPill";
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
      <LocationPillLink location={inventoryitem.location} />
      <ProductPillLink product={inventoryitem.product} />
      <div className="rounded-md bg-muted p-4">
        <UnitMappingGraph unitMapping={inventoryitem.product.unitMappings} />
      </div>
      <Button variant="outline" onClick={onEdit}>
        Edit Inventory Item
      </Button>
    </div>
  );
};
