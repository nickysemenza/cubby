import { locationId, productId } from "@cubby/schemas/identifiers";
import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { z } from "zod";
import { InventoryCaptureWorkspace } from "~/app/inventory/capture/InventoryCaptureWorkspace";

const searchSchema = z.object({
  scanner: z.boolean().optional().catch(undefined),
  locationId: locationId.optional().catch(undefined),
  productId: productId.optional().catch(undefined),
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
    head: () => ({ meta: [{ title: "Quick capture | cubby" }] }),
  },
);

function QuickCapturePage() {
  const { scanner, locationId, productId } = Route.useSearch();

  return (
    <InventoryCaptureWorkspace
      mode="quick"
      initialLocationId={locationId}
      initialProductId={productId}
      initialScannerMode={scanner}
    />
  );
}
