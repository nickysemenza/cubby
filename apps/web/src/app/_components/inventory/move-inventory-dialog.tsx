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

import type { LocationShortcode } from "@cubby/schemas/identifiers";
import { useMutation } from "@tanstack/react-query";
import { uniq } from "es-toolkit";
import { FormProvider } from "react-hook-form";
import { toast } from "sonner";
import {
  DestinationLocationField,
  resolveDestination,
  useDestinationLocationForm,
} from "~/app/_components/inventory/destination-location-picker";
import type { InventoryDialogItem } from "~/app/_components/inventory/dialog-item";
import { useInventoryInvalidation } from "~/app/_components/inventory/hooks";
import { BulkActionDialog } from "~/components/dialogs/bulk-action-dialog";
import { useTRPC } from "~/integrations/trpc/react";
import { getErrorMessage } from "~/lib/error-utils";

type InventoryItem = InventoryDialogItem;

interface MoveInventoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: InventoryItem[];
  /** When omitted, derived from items[0].location.id */
  sourceLocationId?: LocationShortcode;
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
  const sourceLocationIds = uniq(
    items.map((item) => sourceLocationIdProp ?? item.location.id),
  ).filter((id): id is LocationShortcode => Boolean(id));

  const moveMutation = useMutation(
    api.inventory.moveEntries.mutationOptions({
      onError: (err) => {
        setError(err.message || "Failed to move items");
      },
    }),
  );

  const handleSubmit = async () => {
    const values = form.getValues();

    if (sourceLocationIds.length === 0) {
      setError("No source location available");
      return;
    }

    const resolved = resolveDestination(
      values.targetLocation,
      sourceLocationIds,
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

    // One atomic request, whatever the selection spans. This used to group the
    // selection by source location and fire a `bulkMove` per group, because
    // that call pinned a single source — so a failure partway through left the
    // earlier groups moved and reported "moved items from 2 of 3 source
    // locations". `moveEntries` carries the target per item, so there is no
    // partial-completion state left to describe.
    let result: Awaited<ReturnType<typeof moveMutation.mutateAsync>>;
    try {
      result = await moveMutation.mutateAsync({
        items: items.map((item) => ({
          inventoryEntryId: item.id,
          targetLocationId,
          quantity: item.amount,
        })),
      });
    } catch (error) {
      invalidateInventory();
      setError(getErrorMessage(error));
      return;
    }

    toast.success(
      `Successfully moved ${items.length} item${items.length !== 1 ? "s" : ""}`,
    );
    invalidateInventory({ sideEffects: result.sideEffects });
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
        isPending={moveMutation.isPending}
      >
        <DestinationLocationField
          form={form}
          name="targetLocation"
          label="Move to Location"
          error={error}
          sourceLocationIds={sourceLocationIds}
        />
      </BulkActionDialog>
    </FormProvider>
  );
}
