"use client";

import type { FC } from "react";
import type { z } from "zod";
import type { inventoryWithLocationAndProductOut } from "~/schemas/combo";
import { DetailPage, type DetailSection } from "../data-table/detail-page";
import { InventoryForm } from "./inventory-form";
import type { InventoryUpdateInput } from "~/schemas/inventory";
import { useTRPC } from "~/trpc/react";
import { useEntityDetail } from "../hooks/useEntityDetail";
import { InventoryBasicInfo } from "./inventory-basic-info";

type InventoryItem = z.infer<typeof inventoryWithLocationAndProductOut>;

interface InventoryDetailProps {
  inventoryitem: InventoryItem;
}

export const InventoryDetail: FC<InventoryDetailProps> = ({
  inventoryitem,
}) => {
  const api = useTRPC();

  const { commonSections, editMode } = useEntityDetail<
    InventoryItem,
    InventoryUpdateInput
  >({
    entity: "inventory-item",
    data: inventoryitem,
    mutationOptions: api.inventoryItem.update.mutationOptions(),
  });

  const sections: DetailSection[] = [
    {
      title: "Inventory Item Details",
      content: editMode.isEditing ? (
        <InventoryForm
          mode="edit"
          entity={inventoryitem}
          onEdit={editMode.handleEdit}
          onCancel={editMode.handleCancel}
          isPending={editMode.isPending}
          error={editMode.error}
        />
      ) : (
        <InventoryBasicInfo
          inventoryitem={inventoryitem}
          onEdit={editMode.startEditing}
        />
      ),
    },
    // Common sections from entity config (History)
    ...commonSections,
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
