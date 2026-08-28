import { locationShortcode } from "@cubby/schemas/identifiers";
import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { z } from "zod";

import { InventorySessionWorkbench } from "~/app/inventory/session/InventorySessionWorkbench";
import { RouteErrorComponent } from "~/components/lazy-route-error";
import { Page } from "~/components/page/Page";
import { DetailPagePending } from "~/components/route-pending";
import { pageTitle } from "~/lib/page-title";

const searchSchema = z.object({
  parent: locationShortcode.optional().catch(undefined),
});

const searchDefaults = { parent: undefined } as const;

export const Route = createFileRoute("/_authenticated/inventory/session")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  component: InventorySessionPage,
  head: () => ({ meta: [{ title: pageTitle("Inventory session") }] }),
});

function InventorySessionPage() {
  const { parent } = Route.useSearch();

  return (
    <Page
      variant="list"
      title="Inventory session"
      eyebrow="Inventory"
      compact
      decoration="none"
    >
      <InventorySessionWorkbench initialParentShortcode={parent} />
    </Page>
  );
}
