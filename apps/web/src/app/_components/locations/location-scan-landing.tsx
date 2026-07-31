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
import { ArrowRight, PackagePlus, ScanBarcode } from "lucide-react";
import { useState } from "react";
import { Row, Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import { buttonVariants } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { cn } from "~/lib/utils";
import { ShelfTableToggle, type ShelfView } from "../data-table/shelf";
import { QuickInventoryAdd } from "../inventory/quick-inventory-add";
import { LocationBreadcrumb } from "./location-breadcrumb";
import { LocationCardGrid } from "./location-card-grid";
import { LocationInventoryTable } from "./location-inventory-table";

export function LocationScanLanding({ location }: { location: InfLocation }) {
  // Bump a key to force the inventory list to refetch after a quick add.
  const [refreshKey, setRefreshKey] = useState(0);
  const [view, setView] = useState<ShelfView>("shelf");

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

        {/* Secondary quick actions: recount + jump to full detail. */}
        <Row gap="sm" wrap>
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
            <ShelfTableToggle value={view} onChange={setView} />
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
