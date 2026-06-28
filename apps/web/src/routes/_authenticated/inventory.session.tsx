import { locationId } from "@cubby/schemas/identifiers";
import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { z } from "zod";
import { InventorySessionWorkbench } from "~/app/inventory/session/InventorySessionWorkbench";
import { Page } from "~/components/page/Page";
import { RouteErrorComponent } from "~/components/route-error";
import { DetailPagePending } from "~/components/route-pending";

const searchSchema = z.object({
  parentId: locationId.optional().catch(undefined),
});

const searchDefaults = { parentId: undefined } as const;

export const Route = createFileRoute("/_authenticated/inventory/session")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  component: InventorySessionPage,
  head: () => ({ meta: [{ title: "Inventory session | cubby" }] }),
});

function InventorySessionPage() {
  const { parentId } = Route.useSearch();

  return (
    <Page
      variant="list"
      title="Inventory session"
      eyebrow="Inventory"
      compact
      decoration="none"
    >
      <InventorySessionWorkbench initialParentId={parentId} />
    </Page>
  );
}
