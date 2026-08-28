import pluralize from "pluralize";
import { toast } from "sonner";

import type { InventoryDialogItem } from "~/app/_components/inventory/dialog-item";
import { BulkActionDialog } from "~/components/dialogs/bulk-action-dialog";
import { useEntityCommands } from "~/entities/editing/use-entity-commands";

interface DeleteInventoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: InventoryDialogItem[];
  onSuccess: () => void;
}

export function DeleteInventoryDialog({
  open,
  onOpenChange,
  items,
  onSuccess,
}: DeleteInventoryDialogProps) {
  const commands = useEntityCommands("inventory");

  const handleDelete = async () => {
    try {
      // One batched delete (the procedure takes an id array) instead of a
      // per-item mutateAsync fan-out.
      const result = await commands.remove(items.map((item) => item.id));
      if (!result.ok) {
        throw new Error(result.issues[0]?.message ?? "Delete failed");
      }

      toast.success(
        `Successfully deleted ${pluralize("item", items.length, true)}`,
      );
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
      description={`This action cannot be undone. The following ${pluralize("inventory item", items.length)} will be permanently deleted.`}
      renderItem={(item) => item.product.name}
      // The amount and shelf move into the projection: what the row loses is
      // those units at that location, and the entry itself.
      effect={(item) => ({
        from: `${item.amount.value} ${item.amount.unit} at ${item.location.name}`,
        to: "removed",
      })}
      onSubmit={handleDelete}
      isPending={commands.isPending}
      variant="destructive"
    />
  );
}
