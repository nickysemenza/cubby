import type {
  InventoryUpdateInput,
  inventoryWithLocationAndProductOut,
} from "@cubby/schemas/inventory";
import { Package } from "lucide-react";
import { type FC, useState } from "react";
import type { z } from "zod";

import { Page } from "~/components/page/Page";
import { DetailEditAction } from "~/components/ui/detail-edit-action";
import { inventoryEditRequest } from "~/entities/editing/editor-requests";
import { EntityEditDialog } from "~/entities/editing/entity-edit-dialog";

import { type DetailSection, DetailSections } from "../data-table/detail-page";
import { useEntityDetail } from "../hooks/useEntityDetail";
import { InventoryBasicInfo } from "./inventory-basic-info";

type InventoryItem = z.infer<typeof inventoryWithLocationAndProductOut>;

interface InventoryDetailProps {
  record: InventoryItem;
}

export const InventoryDetail: FC<InventoryDetailProps> = ({
  record: inventoryitem,
}) => {
  const [editOpen, setEditOpen] = useState(false);
  const { commonSections } = useEntityDetail<
    "inventory",
    InventoryItem,
    InventoryUpdateInput
  >({
    entity: "inventory",
    data: inventoryitem,
  });

  const sections: DetailSection[] = [
    {
      id: "inventory-details",
      title: "Inventory Item Details",
      icon: Package,
      placement: "primary",
      content: <InventoryBasicInfo inventoryitem={inventoryitem} />,
    },
    ...commonSections,
  ];

  return (
    <Page
      variant="detail"
      entity="inventory"
      title={inventoryitem.product.name}
      rawData={inventoryitem}
      heroActions={{
        primary: <DetailEditAction onClick={() => setEditOpen(true)} />,
      }}
    >
      <DetailSections sections={sections} rawData={inventoryitem} />
      <EntityEditDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        request={inventoryEditRequest(inventoryitem)}
      />
    </Page>
  );
};
