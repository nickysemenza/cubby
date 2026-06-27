import { locationId } from "@cubby/schemas/identifiers";
import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { z } from "zod";
import { InventoryCaptureWorkspace } from "~/app/inventory/capture/InventoryCaptureWorkspace";

const searchSchema = z.object({
  sourceLocationId: locationId.optional().catch(undefined),
});

const searchDefaults = { sourceLocationId: undefined } as const;

export const Route = createFileRoute("/_authenticated/inventory/bulk-move")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  component: BulkInventoryMovePage,
});

function BulkInventoryMovePage() {
  const { sourceLocationId } = Route.useSearch();

  return (
    <InventoryCaptureWorkspace
      mode="bulk-move"
      initialSourceLocationId={sourceLocationId}
    />
  );
}
