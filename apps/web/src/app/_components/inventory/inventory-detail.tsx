import { Package } from "lucide-react";
import type { FC } from "react";
import type { z } from "zod";
import type { inventoryWithLocationAndProductOut } from "~/schemas/combo";
import type { InventoryUpdateInput } from "~/schemas/inventory";
import { useTRPC } from "~/trpc/react";
import { DetailPage, type DetailSection } from "../data-table/detail-page";
import { useEntityDetail } from "../hooks/useEntityDetail";
import { InventoryBasicInfo } from "./inventory-basic-info";
import { InventoryForm } from "./inventory-form";

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
    entity: "inventory",
    data: inventoryitem,
    mutationOptions: api.inventory.update.mutationOptions(),
  });

  const sections: DetailSection[] = [
    {
      title: "Inventory Item Details",
      icon: Package,
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
      entity="inventory"
      name={inventoryitem.product.name}
      rawData={inventoryitem}
    />
  );
};
