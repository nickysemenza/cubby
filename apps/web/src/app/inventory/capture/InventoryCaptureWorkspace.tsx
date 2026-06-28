import type { LocationId } from "@cubby/schemas/identifiers";
import { QuickInventoryAdd } from "~/app/_components/inventory/quick-inventory-add";
import { Page } from "~/components/page/Page";
import BulkInventoryForm from "../bulk-edit/bulk-inventory-form";
import BulkMoveForm from "../bulk-move/bulk-move-form";

type InventoryCaptureWorkspaceProps =
  | {
      mode: "inline";
      locationId: LocationId;
      onSuccess: () => void;
    }
  | {
      mode: "bulk-edit";
      initialLocationId?: LocationId;
    }
  | {
      mode: "bulk-move";
      initialSourceLocationId?: LocationId;
    };

export function InventoryCaptureWorkspace(
  props: InventoryCaptureWorkspaceProps,
) {
  const { mode } = props;

  if (mode === "inline") {
    return (
      <QuickInventoryAdd
        locationId={props.locationId}
        onSuccess={props.onSuccess}
      />
    );
  }

  if (mode === "bulk-edit") {
    return (
      <Page
        variant="list"
        title="Bulk inventory edit"
        eyebrow="Inventory"
        compact
        decoration="none"
      >
        <BulkInventoryForm initialLocationId={props.initialLocationId} />
      </Page>
    );
  }

  if (mode === "bulk-move") {
    return (
      <Page
        variant="list"
        title="Bulk move inventory"
        eyebrow="Inventory"
        compact
        decoration="none"
      >
        <BulkMoveForm initialSourceLocationId={props.initialSourceLocationId} />
      </Page>
    );
  }
}
