import type { inventoryCreatePayloadData } from "@cubby/schemas/inventory";
import type { FC } from "react";
import type { z } from "zod";
import { useEntityCreateMode } from "~/app/_components/hooks/useEntityMode";
import { InventoryForm } from "~/app/_components/inventory/inventory-form";
import { useTRPC } from "~/trpc/react";

const CreateInventoryItem: FC = () => {
  const api = useTRPC();

  const { error, isPending, handleCreate, handleCancel } = useEntityCreateMode<
    z.infer<typeof inventoryCreatePayloadData>,
    { id: string }
  >("inventory", api.inventory.create.mutationOptions());

  return (
    <InventoryForm
      mode="create"
      onCreate={handleCreate}
      isPending={isPending}
      error={error}
      onCancel={handleCancel}
    />
  );
};

export default CreateInventoryItem;
