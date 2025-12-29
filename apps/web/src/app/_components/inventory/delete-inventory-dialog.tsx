import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { z } from "zod";
import { BulkActionDialog } from "~/components/dialogs/bulk-action-dialog";
import { queryKeys } from "~/lib/query-keys";
import type { inventoryWithLocationAndProductOut } from "~/schemas/combo";
import { useTRPC } from "~/trpc/react";

type InventoryItem = z.infer<typeof inventoryWithLocationAndProductOut>;

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
  const queryClient = useQueryClient();

  const deleteMutation = useMutation(
    api.inventoryItem.delete.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: queryKeys.inventoryItem.list,
        });
      },
    }),
  );

  const handleDelete = async () => {
    try {
      await Promise.all(
        items.map((item) => deleteMutation.mutateAsync({ id: item.id })),
      );

      toast.success(
        `Successfully deleted ${items.length} item${items.length !== 1 ? "s" : ""}`,
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
      description={`This action cannot be undone. The following inventory item${items.length !== 1 ? "s" : ""} will be permanently deleted.`}
      renderItem={(item) =>
        `${item.product.name} - ${item.amount.value} ${item.amount.unit}`
      }
      onSubmit={handleDelete}
      isPending={deleteMutation.isPending}
      variant="destructive"
    />
  );
}
