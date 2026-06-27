import { locationId, productId } from "@cubby/schemas/identifiers";
import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { z } from "zod";
import QuickCaptureForm from "~/app/inventory/quick-capture/quick-capture-form";
import { Page } from "~/components/page/Page";
import { useIsMobile } from "~/hooks/useMobile";

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
    <Page
      variant="list"
      eyebrow="Quick capture"
      title={scanner ? "Scan inventory" : "Add inventory"}
      compact
      decoration="none"
    >
      <QuickCaptureForm
        initialLocationId={locationId}
        initialProductId={productId}
        initialScannerMode={scanner}
      />
    </Page>
  );
}
