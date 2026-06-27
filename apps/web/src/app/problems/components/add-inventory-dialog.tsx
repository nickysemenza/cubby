import type { LocationId } from "@cubby/schemas/identifiers";
import { InventoryCaptureWorkspace } from "~/app/inventory/capture/InventoryCaptureWorkspace";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";

interface AddInventoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  locationId: LocationId;
  locationName: string;
  onSuccess: () => void;
}

export function AddInventoryDialog({
  open,
  onOpenChange,
  locationId,
  locationName,
  onSuccess,
}: AddInventoryDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Add Inventory to {locationName}</DialogTitle>
          <DialogDescription>
            Add items to this location. The dialog stays open so you can add
            multiple items.
          </DialogDescription>
        </DialogHeader>
        <InventoryCaptureWorkspace
          mode="inline"
          locationId={locationId}
          onSuccess={onSuccess}
        />
      </DialogContent>
    </Dialog>
  );
}
