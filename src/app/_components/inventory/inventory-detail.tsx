"use client";
import JsonRenderer from "~/app/_components/json-renderer";
import { useWasm } from "~/hooks/useWasm";
import { type inventoryWithLocationAndProductOut } from "~/schemas/combo";
import { z } from "zod";
import { type FC, useState } from "react";
import { showAmountAndPrice } from "./format-amount";
import { LocationPillLink, ProductPillLink } from "../EntityPill";
import { UnitMappingGraph } from "../units/UnitMappingGraph";
import { DetailPage, type DetailSection } from "../data-table/detail-page";
import { Button } from "~/components/ui/button";
import { InventoryForm } from "./inventory-form";
import { type InventoryUpdateInput } from "~/schemas/inventory";
import { useTRPC } from "~/trpc/react";

import { useMutation } from "@tanstack/react-query";

type InventoryItem = z.infer<typeof inventoryWithLocationAndProductOut>;

interface InventoryDetailProps {
  inventoryitem: InventoryItem;
}

export const InventoryDetail: FC<InventoryDetailProps> = ({
  inventoryitem,
}) => {
  const api = useTRPC();
  const w = useWasm();
  const [isEditing, setIsEditing] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const updateMutation = useMutation(
    api.inventoryItem.update.mutationOptions({
      onSuccess: () => {
        setIsEditing(false);
        // Refresh the page to get updated data
        window.location.reload();
      },
      onError: (error) => {
        setError(error.message);
      },
    }),
  );

  const handleEdit = (data: InventoryUpdateInput) => {
    updateMutation.mutate(data);
  };

  // w is always defined with our updated useWasm hook

  const InventoryContent = () => {
    if (isEditing) {
      return (
        <InventoryForm
          mode="edit"
          entity={inventoryitem}
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
          <UnitMappingGraph unitMapping={inventoryitem.product.unitMappings} />
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

  return (
    <DetailPage
      sections={sections}
      entity="inventory-item"
      name={inventoryitem.product.name}
    />
  );
};
