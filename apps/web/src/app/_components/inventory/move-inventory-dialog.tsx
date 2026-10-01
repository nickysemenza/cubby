/**
 * MoveInventoryDialog — move one inventory row or a whole selection (a
 * bulk of one is the single-row case) to another location.
 */

import type { LocationShortcode } from "@cubby/schemas/identifiers";
import { useMutation } from "@tanstack/react-query";
import { uniq } from "es-toolkit";
import { useState } from "react";
import { toast } from "sonner";

import type { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import type { InventoryDialogItem } from "~/app/_components/inventory/dialog-item";
import { useInventoryInvalidation } from "~/app/_components/inventory/hooks";
import {
  LocationDestinationPicker,
  refuseSourceLocations,
} from "~/app/_components/locations/location-move-dialog";
import { BulkActionDialog } from "~/components/dialogs/bulk-action-dialog";
import { inventory } from "~/integrations/tanstack-query/generated/catalog.gen";
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
  const invalidateInventory = useInventoryInvalidation();
  const [targetLocation, setTargetLocation] =
    useState<ComboboxItem<LocationShortcode> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sourceLocationIds = uniq(
    items.map((item) => sourceLocationIdProp ?? item.location.id),
  ).filter((id): id is LocationShortcode => Boolean(id));

  const moveMutation = useMutation(
    inventory.moveEntries.mutationOptions({
      onError: (err) => {
        setError(err.message || "Failed to move items");
      },
    }),
  );

  const handleSubmit = async () => {
    if (sourceLocationIds.length === 0) {
      setError("No source location available");
      return;
    }
    if (!targetLocation) {
      setError("Please select a target location");
      return;
    }
    const targetLocationId = targetLocation.id;
    if (sourceLocationIds.includes(targetLocationId)) {
      setError(
        "Target location must be different from every selected item's current location",
      );
      return;
    }

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
    setTargetLocation(null);
    onSuccess();
    onOpenChange(false);
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setTargetLocation(null);
      setError(null);
    }
    onOpenChange(newOpen);
  };

  return (
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
      // No blocked/unchanged arm: `LocationDestinationPicker` disables every
      // source location in the picker, so a row cannot be asked to move
      // where it already is.
      effect={
        targetLocation
          ? (item) => ({
              from: item.location.name,
              to: targetLocation.name,
            })
          : undefined
      }
      onSubmit={handleSubmit}
      isPending={moveMutation.isPending}
      error={error}
    >
      <LocationDestinationPicker
        label="Move to Location"
        value={targetLocation}
        setValue={(item) => {
          setTargetLocation(item);
          setError(null);
        }}
        disabledReason={refuseSourceLocations(sourceLocationIds)}
      />
    </BulkActionDialog>
  );
}
