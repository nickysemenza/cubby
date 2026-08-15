/**
 * LocationScanLanding — the phone-first landing a bin/location QR resolves to.
 *
 * A scanned location QR is a *physical* entry point: standing at the shelf, the
 * intent is "what's in here / put something here", not "browse the desktop
 * detail page". So instead of hard-redirecting to /locations/$id, a scanned
 * location shortcode lands here — big touch targets, add-item front and center,
 * the contents right below, and a single tap through to the full detail page.
 */

import type { InfLocation } from "@cubby/schemas/location";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Camera, PackagePlus, ScanBarcode } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Row, Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import { Button, buttonVariants } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Spinner } from "~/components/ui/spinner";
import { ViewSwitcher } from "~/components/ui/view-switcher";
import { getErrorMessage } from "~/lib/error-utils";
import { cn } from "~/lib/utils";
import { SHELF_VIEW_OPTIONS, type ShelfView } from "../data-table/shelf";
import { QuickInventoryAdd } from "../inventory/quick-inventory-add";
import { LocationBreadcrumb } from "./location-breadcrumb";
import { LocationCardGrid } from "./location-card-grid";
import { LocationInventoryTable } from "./location-inventory-table";
import { useLocationPhotoCapture } from "./use-location-photo-capture";

export function LocationScanLanding({ location }: { location: InfLocation }) {
  // Bump a key to force the inventory list to refetch after a quick add.
  const [refreshKey, setRefreshKey] = useState(0);
  const [view, setView] = useState<ShelfView>("shelf");
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const { capture, discardCapture, isCapturing } = useLocationPhotoCapture();

  const takePhoto = async (file: File) => {
    try {
      const imageId = await capture(location.id, file);
      toast.success("Photo attached.", {
        action: {
          label: "Retake",
          onClick: () => {
            void discardCapture(location.id, imageId).catch((error: unknown) =>
              toast.error(`Retake failed: ${getErrorMessage(error)}`),
            );
          },
        },
      });
    } catch (error) {
      toast.error(`Photo failed: ${getErrorMessage(error)}`);
    }
  };

  return (
    <Page
      variant="detail"
      entity="location"
      title={location.name}
      eyebrow="Scanned"
      heroNo={location.id ?? undefined}
      rawData={location}
      heroImages={location.images}
    >
      <Stack gap="md">
        <LocationBreadcrumb location={location} linkable />

        {/* Add item here — the primary in-hand action, up top. */}
        <Card>
          <CardContent className="px-4 py-4">
            <Row align="center" gap="sm" className="mb-2">
              <PackagePlus className="size-4 text-muted-foreground" />
              <h2 className="my-0 font-heading font-semibold text-sm">
                Add item here
              </h2>
            </Row>
            <QuickInventoryAdd
              locationId={location.id}
              onSuccess={() => setRefreshKey((k) => k + 1)}
            />
          </CardContent>
        </Card>

        {/* Secondary quick actions: photo, recount, jump to full detail. The
            photo button is here because standing at the bin is the only moment
            the shot can be taken — a new frame becomes the cover and keeps the
            rest, and re-runs this location's AI description. */}
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Clear first so re-picking the same file still fires `change`.
            event.target.value = "";
            if (file) void takePhoto(file);
          }}
        />
        <Row gap="sm" wrap>
          <Button
            type="button"
            variant="outline"
            className="h-12 flex-1 text-sm"
            disabled={isCapturing}
            onClick={() => cameraInputRef.current?.click()}
          >
            {isCapturing ? (
              <Spinner className="mr-2 size-4" />
            ) : (
              <Camera className="mr-2 size-4" />
            )}
            {location.images.length > 0 ? "Retake photo" : "Photo"}
          </Button>
          <Link
            to="/inventory/session"
            search={{ parent: location.id }}
            className={cn(
              buttonVariants({ variant: "outline", size: "default" }),
              "h-12 flex-1 text-sm",
            )}
          >
            <ScanBarcode className="mr-2 size-4" />
            Recount
          </Link>
          <Link
            to="/locations/$shortcode"
            params={{ shortcode: location.id }}
            className={cn(
              buttonVariants({ variant: "outline", size: "default" }),
              "h-12 flex-1 text-sm",
            )}
          >
            Full details
            <ArrowRight className="ml-2 size-4" />
          </Link>
        </Row>

        {/* Locations inside — for a cart/shelf of totes, the child locations
            ARE the contents, so surface them before direct items. */}
        {location.children && location.children.length > 0 && (
          <Stack gap="sm">
            <h2 className="my-0 font-heading font-semibold text-sm">
              Locations inside
            </h2>
            <LocationCardGrid
              locations={location.children}
              showParentPath={false}
            />
          </Stack>
        )}

        {/* Items directly here — the "what's in this exact spot" answer. */}
        <Stack gap="sm">
          <Row align="center" justify="between">
            <h2 className="my-0 font-heading font-semibold text-sm">
              Items here
            </h2>
            <ViewSwitcher
              options={SHELF_VIEW_OPTIONS}
              value={view}
              onValueChange={setView}
            />
          </Row>
          <LocationInventoryTable
            key={refreshKey}
            locationId={location.id}
            view={view}
          />
        </Stack>
      </Stack>
    </Page>
  );
}
