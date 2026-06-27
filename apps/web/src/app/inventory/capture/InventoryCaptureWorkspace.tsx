import type { LocationId, ProductId } from "@cubby/schemas/identifiers";
import { Link } from "@tanstack/react-router";
import { ScanBarcode } from "lucide-react";
import { QuickInventoryAdd } from "~/app/_components/inventory/quick-inventory-add";
import { CaptureFlow } from "~/app/capture/capture-flow";
import { Page } from "~/components/page/Page";
import { Button } from "~/components/ui/button";
import { useIsMobile } from "~/hooks/useMobile";
import BulkInventoryForm from "../bulk-edit/bulk-inventory-form";
import BulkMoveForm from "../bulk-move/bulk-move-form";
import QuickCaptureForm from "../quick-capture/quick-capture-form";

export type InventoryCaptureMode =
  | "quick"
  | "photo"
  | "inline"
  | "bulk-edit"
  | "bulk-move";

type InventoryCaptureWorkspaceProps =
  | {
      mode: "quick";
      initialLocationId?: LocationId;
      initialProductId?: ProductId;
      initialScannerMode?: boolean;
    }
  | {
      mode: "photo";
    }
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
  const isMobile = useIsMobile();

  if (mode === "photo") {
    return (
      <Page
        variant="list"
        eyebrow="Beta"
        title="Scan a shelf"
        compact
        decoration="none"
        actions={
          <Button
            variant="outline"
            render={<Link to="/inventory/quick-capture" />}
            nativeButton={false}
          >
            <ScanBarcode className="mr-1 h-3.5 w-3.5" />
            Quick capture
          </Button>
        }
      >
        <CaptureFlow />
      </Page>
    );
  }

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

  const initialScannerMode = props.initialScannerMode ?? false;
  const isImmersiveScan = isMobile && initialScannerMode;

  if (isImmersiveScan) {
    return (
      <div className="safe-top safe-bottom min-h-[100dvh] px-4 py-4">
        <QuickCaptureForm
          initialLocationId={props.initialLocationId}
          initialProductId={props.initialProductId}
          initialScannerMode={initialScannerMode}
        />
      </div>
    );
  }

  return (
    <Page
      variant="list"
      eyebrow="Quick capture"
      title={initialScannerMode ? "Scan inventory" : "Add inventory"}
      compact
      decoration="none"
    >
      <QuickCaptureForm
        initialLocationId={props.initialLocationId}
        initialProductId={props.initialProductId}
        initialScannerMode={initialScannerMode}
      />
    </Page>
  );
}
