import type { LocationShortcode } from "@cubby/schemas/identifiers";
import { QuickInventoryAdd } from "~/app/_components/inventory/quick-inventory-add";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";

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
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={`Add Inventory to ${locationName}`}
      description="Add items to this location. The dialog stays open so you can add multiple items."
    >
      <QuickInventoryAdd locationId={locationId} onSuccess={onSuccess} />
    </ResponsiveDialog>
  );
}
