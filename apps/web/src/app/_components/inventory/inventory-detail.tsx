import type { inventoryWithLocationAndProductOut } from "@cubby/schemas/combo";
import type { InventoryUpdateInput } from "@cubby/schemas/inventory";
import { ArrowRightLeft, Package, Pencil } from "lucide-react";
import type { FC } from "react";
import { useState } from "react";
import type { z } from "zod";
import { Page } from "~/components/page/Page";
import { Button } from "~/components/ui/button";
import { queryKeys } from "~/lib/query-keys";
import { useTRPC } from "~/trpc/react";
import { type DetailSection, DetailSections } from "../data-table/detail-page";
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

  const { DeleteButton, DeleteDialog, isPending } = useEntityDelete({
    id: inventoryitem.id,
    name: inventoryitem.product.name,
    entityLabel: "Inventory Entry",
    mutationOptions: (callbacks) =>
      api.inventory.delete.mutationOptions(callbacks),
    invalidateKeys: [[queryKeys.inventory.list], [queryKeys.location.all]],
    redirectTo: "/inventory",
  });

  const sections: DetailSection[] = [
    editableDetailSection({
      title: "Inventory Item Details",
      icon: Package,
      editMode,
      Form: InventoryForm,
      entity: inventoryitem,
      children: <InventoryBasicInfo inventoryitem={inventoryitem} />,
    }),
    // Common sections from entity config (History)
    ...commonSections,
  ];

  // Page-level action cluster on the hero plate. Edit/Move/Delete are disabled
  // while a delete is in flight so the row reads as "deleting" before the
  // redirect lands.
  const actions = (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={editMode.startEditing}
        disabled={isPending}
      >
        <Pencil className="mr-2 h-4 w-4" />
        Edit
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setShowMoveDialog(true)}
        disabled={isPending}
      >
        <ArrowRightLeft className="mr-2 h-4 w-4" />
        Move
      </Button>
      <DeleteButton />
    </div>
  );

  return (
    <>
      <Page
        variant="detail"
        entity="inventory"
        title={inventoryitem.product.name}
        rawData={inventoryitem}
        actions={actions}
      >
        <DetailSections sections={sections} rawData={inventoryitem} />
      </Page>
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
