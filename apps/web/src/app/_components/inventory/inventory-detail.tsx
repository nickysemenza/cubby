"use client";
import { type inventoryWithLocationAndProductOut } from "~/schemas/combo";
import { z } from "zod";
import { type FC, useMemo } from "react";
import { showAmountAndPrice } from "./format-amount";
import { LocationPillLink, ProductPillLink } from "../EntityPill";
import { UnitMappingGraph } from "../units/UnitMappingGraph";
import { DetailPage, type DetailSection } from "../data-table/detail-page";
import { Button } from "~/components/ui/button";
import { InventoryForm } from "./inventory-form";
import { type InventoryUpdateInput } from "~/schemas/inventory";
import { useTRPC } from "~/trpc/react";
import { useEditMode } from "../hooks/useEditMode";

type InventoryItem = z.infer<typeof inventoryWithLocationAndProductOut>;

interface InventoryDetailProps {
  inventoryitem: InventoryItem;
}

export const InventoryDetail: FC<InventoryDetailProps> = ({
  inventoryitem,
}) => {
  const api = useTRPC();
  const editMode = useEditMode<InventoryUpdateInput>({
    mutationOptions: api.inventoryItem.update.mutationOptions(),
    useRouterRefresh: true,
  });

  const inventoryContent = useMemo(() => {
    if (editMode.isEditing) {
      return (
        <InventoryForm
          mode="edit"
          entity={inventoryitem}
          onEdit={editMode.handleEdit}
          onCancel={editMode.handleCancel}
          isPending={editMode.isPending}
          error={editMode.error}
        />
      );
    }

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
        <div className="bg-muted rounded-md p-4">
          <UnitMappingGraph unitMapping={inventoryitem.product.unitMappings} />
        </div>
        <Button variant="outline" onClick={editMode.startEditing}>
          Edit Inventory Item
        </Button>
      </div>
    );
  }, [editMode, inventoryitem]);

  const sections: DetailSection[] = [
    {
      title: "Inventory Item Details",
      content: inventoryContent,
    },
  ];

  return (
    <DetailPage
      sections={sections}
      entity="inventory-item"
      name={inventoryitem.product.name}
      rawData={inventoryitem}
    />
  );
};
