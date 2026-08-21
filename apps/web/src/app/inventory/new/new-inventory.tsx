import type { inventoryCreatePayloadData } from "@cubby/schemas/inventory";
import type { FC } from "react";
import type { z } from "zod";
import { useInventoryInvalidation } from "~/app/_components/inventory/hooks";
import { InventoryForm } from "~/app/_components/inventory/inventory-form";
import { useEntityCreateController } from "~/entities/editing";

const CreateInventoryItem: FC = () => {
  const invalidateInventory = useInventoryInvalidation();

  const { error, isPending, submit, cancel } = useEntityCreateController<
    "inventory",
    z.infer<typeof inventoryCreatePayloadData>,
    { id: string }
  >("inventory", {
    onSuccess: invalidateInventory,
  });

  return (
    <InventoryForm
      mode="create"
      onCreate={submit}
      isPending={isPending}
      error={error}
      onCancel={cancel}
    />
  );
};

export default CreateInventoryItem;
