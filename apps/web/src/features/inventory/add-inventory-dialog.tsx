import type { LocationShortcode } from "@cubby/schemas/identifiers";

import { QuickInventoryAdd } from "~/features/inventory/quick-inventory-add";
import { Overlay } from "~/ui/overlays/overlay";

interface AddInventoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  locationId: LocationShortcode;
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
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={`Add Inventory to ${locationName}`}
      description="Add items to this location. The dialog stays open so you can add multiple items."
      cancelLabel="Done"
    >
      <QuickInventoryAdd locationId={locationId} onSuccess={onSuccess} />
    </Overlay>
  );
}
