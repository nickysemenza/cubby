"use client";

import type { z } from "zod";
import { useTRPC } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { toast } from "sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { inventoryWithLocationAndProductOut } from "~/schemas/combo";
import { queryKeys } from "~/lib/query-keys";

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
      // Delete items one by one (could be optimized with bulk delete in the future)
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Delete {items.length} Item{items.length !== 1 ? "s" : ""}?
          </DialogTitle>
          <DialogDescription>
            This action cannot be undone. The following inventory item
            {items.length !== 1 ? "s" : ""} will be permanently deleted.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <ul className="max-h-32 space-y-1 overflow-y-auto text-muted-foreground text-sm">
            {items.map((item) => (
              <li key={item.id}>
                {item.product.name} - {item.amount.value} {item.amount.unit}
              </li>
            ))}
          </ul>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={deleteMutation.isPending}
          >
            {deleteMutation.isPending ? "Deleting..." : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
