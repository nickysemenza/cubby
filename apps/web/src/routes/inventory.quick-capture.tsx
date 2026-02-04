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
