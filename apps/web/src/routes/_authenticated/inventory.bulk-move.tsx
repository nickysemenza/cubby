import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { z } from "zod";
import BulkMoveForm from "~/app/inventory/bulk-move/bulk-move-form";
import { Page } from "~/components/page/Page";

const searchSchema = z.object({
  sourceLocationId: z.string().optional().catch(undefined),
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
