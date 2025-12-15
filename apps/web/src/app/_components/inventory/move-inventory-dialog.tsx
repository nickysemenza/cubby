"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTRPC } from "~/trpc/react";
import { ComboboxItem as ComboboxItemSchema } from "~/app/_components/combobox/combobox-types";
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
import { type LocationId, type InventoryId } from "~/schemas/identifiers";
import { useMutation } from "@tanstack/react-query";
import { ComboboxFieldWithSearch } from "~/app/_components/form-utils";
import { type BulkMoveItem } from "~/schemas/inventory";
import { inventoryWithLocationAndProductOut } from "~/schemas/combo";
import { Form } from "~/components/ui/form";

type InventoryItem = z.infer<typeof inventoryWithLocationAndProductOut>;

interface MoveInventoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: InventoryItem[];
  sourceLocationId: LocationId;
  onSuccess: () => void;
}

const formSchema = z.object({
  targetLocation: ComboboxItemSchema.nullable(),
});

type FormValues = z.infer<typeof formSchema>;

export function MoveInventoryDialog({
  open,
  onOpenChange,
  items,
  sourceLocationId,
  onSuccess,
}: MoveInventoryDialogProps) {
  const api = useTRPC();
  const [error, setError] = useState<string | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      targetLocation: null,
    },
  });

  const bulkMoveMutation = useMutation(
    api.inventoryItem.bulkMove.mutationOptions({
      onSuccess: () => {
        toast.success(
          `Successfully moved ${items.length} item${items.length !== 1 ? "s" : ""}`,
        );
        form.reset();
        onSuccess();
        onOpenChange(false);
      },
      onError: (err) => {
        setError(err.message || "Failed to move items");
      },
    }),
  );

  const onSubmit = async (values: FormValues) => {
    if (!values.targetLocation) {
      setError("Please select a target location");
      return;
    }

    if (values.targetLocation.id === sourceLocationId) {
      setError("Target location must be different from source location");
      return;
    }

    setError(null);

    const moveItems: BulkMoveItem[] = items.map((item) => ({
      inventoryEntryId: item.id as InventoryId,
      quantity: item.amount,
    }));

    await bulkMoveMutation.mutateAsync({
      sourceLocationId,
      targetLocationId: values.targetLocation.id as LocationId,
      items: moveItems,
    });
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      form.reset();
      setError(null);
    }
    onOpenChange(newOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Move {items.length} Item{items.length !== 1 ? "s" : ""}
          </DialogTitle>
          <DialogDescription>
            Select a destination location for the selected inventory item
            {items.length !== 1 ? "s" : ""}.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-2">
              <div className="text-sm font-medium">Items to move:</div>
              <ul className="text-muted-foreground max-h-32 space-y-1 overflow-y-auto text-sm">
                {items.map((item) => (
                  <li key={item.id}>
                    {item.product.name} - {item.amount.value} {item.amount.unit}
                  </li>
                ))}
              </ul>
            </div>

            <ComboboxFieldWithSearch
              form={form}
              name="targetLocation"
              label="Move to Location"
              searchType="location"
            />

            {error && <div className="text-destructive text-sm">{error}</div>}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => handleOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={bulkMoveMutation.isPending}>
                {bulkMoveMutation.isPending ? "Moving..." : "Move"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
