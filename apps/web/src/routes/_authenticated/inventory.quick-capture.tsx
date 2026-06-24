import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
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
import { useIsMobile } from "~/hooks/useMobile";

const searchSchema = z.object({
  scanner: z.boolean().optional().catch(undefined),
  locationId: z.string().optional().catch(undefined),
  productId: z.string().optional().catch(undefined),
});

const searchDefaults = {
  scanner: undefined,
  locationId: undefined,
  productId: undefined,
} as const;

export const Route = createFileRoute("/_authenticated/inventory/quick-capture")(
  {
    validateSearch: searchSchema,
    search: { middlewares: [stripSearchParams(searchDefaults)] },
    component: QuickCapturePage,
  },
);

function QuickCapturePage() {
  const { scanner, locationId, productId } = Route.useSearch();
  const isMobile = useIsMobile();
  const isImmersiveScan = isMobile && !!scanner;

  if (isImmersiveScan) {
    return (
      <div className="safe-top safe-bottom min-h-[100dvh] px-4 py-4">
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
