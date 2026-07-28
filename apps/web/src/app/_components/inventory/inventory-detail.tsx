import type {
  InventoryUpdateInput,
  inventoryWithLocationAndProductOut,
} from "@cubby/schemas/inventory";
import { ArrowRightLeft, Package, Pencil } from "lucide-react";
import type { FC } from "react";
import { useState } from "react";
import type { z } from "zod";
import { Row } from "~/components/layout";
import { Page } from "~/components/page/Page";
import { Button } from "~/components/ui/button";
import { useTRPC } from "~/integrations/trpc/react";
import { inventoryMutationInvalidateKeys } from "~/lib/query-keys";
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
    invalidateKeys: inventoryMutationInvalidateKeys,
  });

  const { deleteButton, deleteDialog, isPending } = useEntityDelete({
    id: inventoryitem.id,
    name: inventoryitem.product.name,
    entityLabel: "Inventory Entry",
    mutationOptions: (callbacks) =>
      api.inventory.delete.mutationOptions(callbacks),
    invalidateKeys: inventoryMutationInvalidateKeys,
    redirectTo: "/inventory",
  });

  const sections: DetailSection[] = [
    editableDetailSection({
      title: "Inventory Item Details",
      icon: Package,
      zone: "main",
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
    <Row align="center" gap="sm">
      <Button
        variant="outline"
        size="sm"
        onClick={editMode.startEditing}
        disabled={isPending}
      >
        <Pencil />
        Edit
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setShowMoveDialog(true)}
        disabled={isPending}
      >
        <ArrowRightLeft />
        Move
      </Button>
      {deleteButton}
    </Row>
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
      {deleteDialog}
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
