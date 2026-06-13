import type { inventoryWithLocationAndProductOut } from "@cubby/schemas/combo";
import type { InventoryUpdateInput } from "@cubby/schemas/inventory";
import { Package } from "lucide-react";
import type { FC } from "react";
import { useState } from "react";
import type { z } from "zod";
import { queryKeys } from "~/lib/query-keys";
import { useTRPC } from "~/trpc/react";
import { DetailPage, type DetailSection } from "../data-table/detail-page";
import { editableDetailSection } from "../data-table/editable-detail-section";
import { useEntityDelete } from "../hooks/useEntityDelete";
import { useEntityDetail } from "../hooks/useEntityDetail";
import { InventoryBasicInfo } from "./inventory-basic-info";
import { InventoryForm } from "./inventory-form";
import { MoveInventoryDialog } from "./move-inventory-dialog";

type InventoryItem = z.infer<typeof inventoryWithLocationAndProductOut>;

interface InventoryDetailProps {
  inventoryitem: InventoryItem;
}

export const InventoryDetail: FC<InventoryDetailProps> = ({
  inventoryitem,
}) => {
  const api = useTRPC();
  const [showMoveDialog, setShowMoveDialog] = useState(false);

  const { commonSections, editMode } = useEntityDetail<
    InventoryItem,
    InventoryUpdateInput
  >({
    entity: "inventory",
    data: inventoryitem,
    mutationOptions: api.inventory.update.mutationOptions(),
  });

  const { DeleteButton, DeleteDialog } = useEntityDelete({
    id: inventoryitem.id,
    name: inventoryitem.product.name,
    entityLabel: "Inventory Entry",
    mutationOptions: (callbacks) =>
      api.inventory.delete.mutationOptions(callbacks),
    invalidateKeys: [[queryKeys.inventory.list]],
    redirectTo: "/inventory",
  });

  const sections: DetailSection[] = [
    editableDetailSection({
      title: "Inventory Item Details",
      icon: Package,
      editMode,
      Form: InventoryForm,
      entity: inventoryitem,
      children: (
        <InventoryBasicInfo
          inventoryitem={inventoryitem}
          onEdit={editMode.startEditing}
          onMove={() => setShowMoveDialog(true)}
          DeleteButton={DeleteButton}
        />
      ),
    }),
    // Common sections from entity config (History)
    ...commonSections,
  ];

  return (
    <>
      <DetailPage
        sections={sections}
        entity="inventory"
        name={inventoryitem.product.name}
        rawData={inventoryitem}
      />
      <DeleteDialog />
      {showMoveDialog && (
        <MoveInventoryDialog
          open
          onOpenChange={setShowMoveDialog}
          items={[inventoryitem]}
          onSuccess={() => setShowMoveDialog(false)}
        />
      )}
    </>
  );
};
