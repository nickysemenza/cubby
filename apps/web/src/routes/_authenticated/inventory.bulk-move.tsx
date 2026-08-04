import { locationId } from "@cubby/schemas/identifiers";
import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { z } from "zod";
import BulkMoveForm from "~/app/inventory/bulk-move/bulk-move-form";
import { Page } from "~/components/page/Page";
import { pageTitle } from "~/lib/page-title";

const searchSchema = z.object({
  sourceLocationId: locationId.optional().catch(undefined),
});

const searchDefaults = { sourceLocationId: undefined } as const;

export const Route = createFileRoute("/_authenticated/inventory/bulk-move")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  head: () => ({ meta: [{ title: pageTitle("Bulk move inventory") }] }),
  component: BulkInventoryMovePage,
});

function BulkInventoryMovePage() {
  const { sourceLocationId } = Route.useSearch();

  return (
    <Page
      variant="list"
      title="Bulk move inventory"
      eyebrow="Inventory"
      compact
      decoration="none"
    >
      <BulkMoveForm initialSourceLocationId={sourceLocationId} />
    </Page>
  );
}
