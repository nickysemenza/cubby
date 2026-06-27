import { locationId } from "@cubby/schemas/identifiers";
import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { z } from "zod";
import { InventoryCaptureWorkspace } from "~/app/inventory/capture/InventoryCaptureWorkspace";

const searchSchema = z.object({
  locationId: locationId.optional().catch(undefined),
});

const searchDefaults = { locationId: undefined } as const;

export const Route = createFileRoute("/_authenticated/inventory/bulk-edit")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  component: BulkInventoryEditPage,
});

function BulkInventoryEditPage() {
  const { locationId } = Route.useSearch();

  return (
    <InventoryCaptureWorkspace
      mode="bulk-edit"
      initialLocationId={locationId}
    />
  );
}
