import type { inventoryListItemOut } from "@cubby/schemas/inventory-responses";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import type { z } from "zod";
import { useInventoryInvalidation } from "~/app/_components/inventory/hooks";
import { BulkActionDialog } from "~/components/dialogs/bulk-action-dialog";
import { countLabel, pluralize } from "~/lib/pluralize";
import { useTRPC } from "~/trpc/react";

type InventoryItem = z.infer<typeof inventoryListItemOut>;

interface DeleteInventoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: InventoryItem[];
  onSuccess: () => void;
}

export function DeleteInventoryDialog({
  open,
  onOpenChange,
  items,
  onSuccess,
}: DeleteInventoryDialogProps) {
  const api = useTRPC();
  const invalidateInventory = useInventoryInvalidation();

  const deleteMutation = useMutation(
    api.inventory.delete.mutationOptions({
      onSuccess: invalidateInventory,
    }),
  );

  const handleDelete = async () => {
    try {
      // One batched delete (the procedure takes an id array) instead of a
      // per-item mutateAsync fan-out.
      await deleteMutation.mutateAsync({ ids: items.map((item) => item.id) });

      toast.success(`Successfully deleted ${countLabel(items.length, "item")}`);
      onSuccess();
      onOpenChange(false);
    } catch {
      toast.error("Failed to delete items");
    }
  };

  return (
    <BulkActionDialog
      open={open}
      onOpenChange={onOpenChange}
      items={items}
      action="Delete"
      pendingLabel="Deleting..."
      description={`This action cannot be undone. The following ${pluralize(items.length, "inventory item")} will be permanently deleted.`}
      renderItem={(item) =>
        `${item.product.name} - ${item.amount.value} ${item.amount.unit}`
      }
      onSubmit={handleDelete}
      isPending={deleteMutation.isPending}
      variant="destructive"
    />
  );
}
