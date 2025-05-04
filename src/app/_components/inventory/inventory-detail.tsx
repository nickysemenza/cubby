"use client";

import JsonRenderer from "~/app/_components/json-renderer";
import { useWasm } from "~/wasmContext";
import { type inventoryWithLocationAndProductOut } from "~/schemas/combo";
import { z } from "zod";
import { type FC, useState } from "react";
import { showAmountAndPrice } from "./format-amount";
import { LocationPillLink, ProductPillLink } from "../EntityPill";
import { buildunitMappingsGraph } from "../units/UnitMappingGraph";
import { DetailPage, type DetailSection } from "../data-table/detail-page";
import { Button } from "~/components/ui/button";
import { 
  InventoryForm, 
  type UpdateInventoryData 
} from "./inventory-form";
import { api } from "~/trpc/react";

type InventoryItem = z.infer<typeof inventoryWithLocationAndProductOut>;

interface InventoryDetailProps {
  inventoryitem: InventoryItem;
}

export const InventoryDetail: FC<InventoryDetailProps> = ({
  inventoryitem,
}) => {
  const { w } = useWasm();
  const [isEditing, setIsEditing] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const updateMutation = api.inventoryItem.update.useMutation({
    onSuccess: () => {
      setIsEditing(false);
      // Refresh the page to get updated data
      window.location.reload();
    },
    onError: (error) => {
      setError(error.message);
    },
  });

  const handleEdit = (data: UpdateInventoryData) => {
    updateMutation.mutate(data);
  };

  if (!w) {
    return <div>Loading...</div>;
  }

  const InventoryContent = () => {
    if (isEditing) {
      return (
        <InventoryForm
          mode="edit"
          inventoryItem={inventoryitem}
          onEdit={handleEdit}
          onCancel={() => setIsEditing(false)}
          isPending={updateMutation.isPending}
          error={error}
        />
      );
    }

    return (
      <div className="space-y-4">
        <div className="text-lg">
          {showAmountAndPrice(
            w,
            inventoryitem.amount,
            inventoryitem.product.unitMappings,
          )}
        </div>
        <LocationPillLink location={inventoryitem.location} />
        <ProductPillLink product={inventoryitem.product} />
        <div className="bg-muted rounded-md p-4">
          {buildunitMappingsGraph(w, inventoryitem.product.unitMappings)}
        </div>
        <Button variant="outline" onClick={() => setIsEditing(true)}>
          Edit Inventory Item
        </Button>
      </div>
    );
  };

  const sections: DetailSection[] = [
    {
      title: "Inventory Item Details",
      content: <InventoryContent />,
    },
    {
      title: "Raw Details",
      content: (
        <div className="bg-muted rounded-md p-4">
          <JsonRenderer input={inventoryitem} />
        </div>
      ),
    },
  ];

  return <DetailPage sections={sections} title="inventory-item" />;
};