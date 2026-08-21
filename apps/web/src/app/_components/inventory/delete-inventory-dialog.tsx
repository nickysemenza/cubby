import pluralize from "pluralize";
import { useMemo } from "react";
import { toast } from "sonner";
import {
  OperationImpact,
  useOperationPreview,
} from "~/app/_components/impact/operation-impact";
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

  // Impact preview — fetched only while the dialog is open, always fresh for
  // the current items. See `useOperationPreview`'s doc comment for the
  // gating rule.
  const previewInput = useMemo(
    () =>
      items.length > 0
        ? {
            operation: "delete" as const,
            entity: "inventory" as const,
            ids: items.map((item) => item.id),
          }
        : null,
    [items],
  );
  const preview = useOperationPreview(previewInput, open);

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
      renderItem={(item) =>
        `${item.product.name} - ${item.amount.value} ${item.amount.unit}`
      }
      onSubmit={handleDelete}
      isPending={commands.isPending}
      variant="destructive"
      blocked={preview.data?.canProceed === false}
    >
      <OperationImpact
        preview={preview.data}
        isLoading={preview.isLoading}
        isError={preview.isError}
        onRetry={() => void preview.refetch()}
      />
    </BulkActionDialog>
  );
}
