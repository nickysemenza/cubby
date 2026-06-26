import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { z } from "zod";
import BulkInventoryForm from "~/app/inventory/bulk-edit/bulk-inventory-form";
import { Page } from "~/components/page/Page";

const searchSchema = z.object({
  locationId: z.string().optional().catch(undefined),
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
    <Page
      variant="list"
      title="Bulk inventory edit"
      eyebrow="Inventory"
      compact
      decoration="none"
    >
      <BulkInventoryForm initialLocationId={locationId} />
    </Page>
  );
}
