import type { LocationId, ProductId } from "@cubby/schemas/identifiers";
import { Link } from "@tanstack/react-router";
import { ScanBarcode } from "lucide-react";
import { CaptureFlow } from "~/app/capture/capture-flow";
import { Page } from "~/components/page/Page";
import { Button } from "~/components/ui/button";
import { useIsMobile } from "~/hooks/useMobile";
import QuickCaptureForm from "../quick-capture/quick-capture-form";

export type InventoryCaptureMode = "quick" | "photo";

interface InventoryCaptureWorkspaceProps {
  mode: InventoryCaptureMode;
  initialLocationId?: LocationId;
  initialProductId?: ProductId;
  initialScannerMode?: boolean;
}

export function InventoryCaptureWorkspace({
  mode,
  initialLocationId,
  initialProductId,
  initialScannerMode = false,
}: InventoryCaptureWorkspaceProps) {
  const isMobile = useIsMobile();
  const isImmersiveScan = mode === "quick" && isMobile && initialScannerMode;

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

  if (isImmersiveScan) {
    return (
      <div className="safe-top safe-bottom min-h-[100dvh] px-4 py-4">
        <QuickCaptureForm
          initialLocationId={initialLocationId}
          initialProductId={initialProductId}
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
        initialLocationId={initialLocationId}
        initialProductId={initialProductId}
        initialScannerMode={initialScannerMode}
      />
    </Page>
  );
}
