/**
 * MoveInventoryDialog - Lightweight modal for moving inventory items to another location.
 *
 * Use this component when:
 * - Moving items from a known source location (e.g., location detail page)
 * - Quick single or bulk moves where source context is already established
 * - Moves that don't require partial quantity selection
 *
 * For more complex move workflows with source/target selection, partial quantities,
 * and select-all functionality, use the dedicated BulkMoveForm page instead.
 *
 * @see /inventory/bulk-move - Full page bulk move workflow
 */

import type { LocationId } from "@cubby/schemas/identifiers";
import type {
  BulkMoveItem,
  inventoryListItemOut,
} from "@cubby/schemas/inventory";
import { useMutation } from "@tanstack/react-query";
import { FormProvider } from "react-hook-form";
import { toast } from "sonner";
import type { z } from "zod";
import {
  DestinationLocationField,
  resolveDestination,
  useDestinationLocationForm,
} from "~/app/_components/inventory/destination-location-picker";
import { useInventoryInvalidation } from "~/app/_components/inventory/hooks";
import { BulkActionDialog } from "~/components/dialogs/bulk-action-dialog";
import { useTRPC } from "~/integrations/trpc/react";

type InventoryItem = z.infer<typeof inventoryListItemOut>;

interface MoveInventoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: InventoryItem[];
  /** When omitted, derived from items[0].location.id */
  sourceLocationId?: LocationId;
  onSuccess: () => void;
}

export function MoveInventoryDialog({
  open,
  onOpenChange,
  items,
  sourceLocationId: sourceLocationIdProp,
  onSuccess,
}: MoveInventoryDialogProps) {
  const api = useTRPC();
  const invalidateInventory = useInventoryInvalidation();
  const { form, error, setError, reset } = useDestinationLocationForm();

  const bulkMoveMutation = useMutation(
    api.inventory.bulkMove.mutationOptions({
      onError: (err) => {
        setError(err.message || "Failed to move items");
      },
    }),
  );

  const handleSubmit = async () => {
    const values = form.getValues();

    const sourceGroups = new Map<LocationId, InventoryItem[]>();
    for (const item of items) {
      const sourceLocationId = sourceLocationIdProp ?? item.location.id;
      if (!sourceLocationId) {
        setError("No source location available");
        return;
      }
      const group = sourceGroups.get(sourceLocationId) ?? [];
      group.push(item);
      sourceGroups.set(sourceLocationId, group);
    }

    if (sourceGroups.size === 0) {
      setError("No source location available");
      return;
    }

    const resolved = resolveDestination(
      values.targetLocation,
      [...sourceGroups.keys()],
      {
        missingTarget: "Please select a target location",
        sameAsSource:
          "Target location must be different from every selected item's current location",
      },
    );
    if (!resolved.ok) {
      setError(resolved.error);
      return;
    }
    const targetLocationId = resolved.id;

    setError(null);

    let completedGroups = 0;
    const results: Array<
      Awaited<ReturnType<typeof bulkMoveMutation.mutateAsync>>
    > = [];
    try {
      for (const [sourceLocationId, sourceItems] of sourceGroups) {
        const moveItems: BulkMoveItem[] = sourceItems.map((item) => ({
          inventoryEntryId: item.id,
          quantity: item.amount,
        }));

        results.push(
          await bulkMoveMutation.mutateAsync({
            sourceLocationId,
            targetLocationId,
            items: moveItems,
          }),
        );
        completedGroups += 1;
      }
    } catch (error) {
      invalidateInventory();
      setError(
        completedGroups > 0
          ? `Moved items from ${completedGroups} of ${sourceGroups.size} source locations before the move failed. The list has been refreshed.`
          : error instanceof Error
            ? error.message
            : "Failed to move items",
      );
      return;
    }

    toast.success(
      `Successfully moved ${items.length} item${items.length !== 1 ? "s" : ""}`,
    );
    // Poll every group's queued valuation work, not just the last group's.
    invalidateInventory({
      sideEffects: {
        backgroundBatches: results.flatMap(
          (r) => r.sideEffects.backgroundBatches,
        ),
      },
    });
    form.reset();
    onSuccess();
    onOpenChange(false);
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      reset();
    }
    onOpenChange(newOpen);
  };

  return (
    <FormProvider {...form}>
      <BulkActionDialog
        open={open}
        onOpenChange={handleOpenChange}
        items={items}
        action="Move"
        pendingLabel="Moving..."
        description={`Select a destination location for the selected inventory item${items.length !== 1 ? "s" : ""}.`}
        renderItem={(item) =>
          `${item.product.name} - ${item.amount.value} ${item.amount.unit}`
        }
        onSubmit={handleSubmit}
        isPending={bulkMoveMutation.isPending}
      >
        <DestinationLocationField
          form={form}
          name="targetLocation"
          label="Move to Location"
          error={error}
        />
      </BulkActionDialog>
    </FormProvider>
  );
}
