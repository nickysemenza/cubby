import type { LocationShortcode } from "@cubby/schemas/identifiers";

import { QuickInventoryAdd } from "~/features/inventory/quick-inventory-add";
import { Row } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { ResponsiveDialog } from "~/ui/primitives/responsive-dialog";

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
      footer={
        <Row justify="end">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Done
          </Button>
        </Row>
      }
    >
      <QuickInventoryAdd locationId={locationId} onSuccess={onSuccess} />
    </ResponsiveDialog>
  );
}
