import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import QuickCaptureForm from "~/app/inventory/quick-capture/quick-capture-form";
import { PageWrapper } from "~/components/layout/page-wrapper";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { useIsMobile } from "~/hooks/use-mobile";

const searchSchema = z.object({
  scanner: z.boolean().optional(),
  locationId: z.string().optional(),
  productId: z.string().optional(),
});

export const Route = createFileRoute("/inventory/quick-capture")({
  validateSearch: searchSchema,
  component: QuickCapturePage,
});

function QuickCapturePage() {
  const { scanner, locationId, productId } = Route.useSearch();
  const isMobile = useIsMobile();
  const isImmersiveScan = isMobile && !!scanner;

  if (isImmersiveScan) {
    return (
      <div className="safe-top safe-bottom min-h-[100dvh] px-3 py-3">
        <QuickCaptureForm
          initialLocationId={locationId}
          initialProductId={productId}
          initialScannerMode={scanner}
        />
      </div>
    );
  }

  return (
    <PageWrapper>
      <Card>
        <CardHeader>
          <CardTitle>Add Inventory</CardTitle>
          <CardDescription>
            {scanner
              ? "Scan barcodes to quickly add items to inventory"
              : "Quickly add inventory items by scanning barcodes or typing"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <QuickCaptureForm
            initialLocationId={locationId}
            initialProductId={productId}
            initialScannerMode={scanner}
          />
        </CardContent>
      </Card>
    </PageWrapper>
  );
}
