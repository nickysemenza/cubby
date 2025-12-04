"use client";
import { type FC } from "react";
import { InventoryForm } from "~/app/_components/inventory/inventory-form";
import { type z } from "zod";
import { type inventoryCreatePayloadData } from "~/schemas/inventory";
import { useTRPC } from "~/trpc/react";
import { useEntityCreateMode } from "~/app/_components/hooks/useEntityMode";

const CreateInventoryItem: FC = () => {
  const api = useTRPC();

  const { error, isPending, handleCreate, handleCancel } = useEntityCreateMode<
    z.infer<typeof inventoryCreatePayloadData>,
    { id: string }
  >("inventory-item", api.inventoryItem.create.mutationOptions());

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Create New Inventory Item</h1>
      <InventoryForm
        mode="create"
        onCreate={handleCreate}
        isPending={isPending}
        error={error}
        onCancel={handleCancel}
      />
    </div>
  );
};

export default CreateInventoryItem;
