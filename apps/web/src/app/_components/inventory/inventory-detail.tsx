import type {
  InventoryUpdateInput,
  inventoryWithLocationAndProductOut,
} from "@cubby/schemas/inventory";
import { Package } from "lucide-react";
import type { FC } from "react";
import type { z } from "zod";
import { Page } from "~/components/page/Page";
import { DetailEditAction } from "~/components/ui/detail-edit-action";
import { type DetailSection, DetailSections } from "../data-table/detail-page";
import { editableDetailSection } from "../data-table/editable-detail-section";
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
  const { commonSections, editMode } = useEntityDetail<
    InventoryItem,
    InventoryUpdateInput
  >({
    entity: "inventory",
    data: inventoryitem,
  });

  const sections: DetailSection[] = [
    editableDetailSection({
      id: "inventory-details",
      title: "Inventory Item Details",
      icon: Package,
      placement: "primary",
      editMode,
      Form: InventoryForm,
      entity: inventoryitem,
      children: <InventoryBasicInfo inventoryitem={inventoryitem} />,
    }),
    ...commonSections,
  ];

  return (
    <Page
      variant="detail"
      entity="inventory"
      title={inventoryitem.product.name}
      rawData={inventoryitem}
      heroActions={{
        primary: <DetailEditAction onClick={editMode.startEditing} />,
      }}
    >
      <DetailSections sections={sections} rawData={inventoryitem} />
    </Page>
  );
};
