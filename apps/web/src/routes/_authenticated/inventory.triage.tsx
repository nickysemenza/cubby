import {
  productCategoryShortcode,
  runShortcode,
} from "@cubby/schemas/identifiers";
import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { z } from "zod";

import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { RouteErrorComponent } from "~/components/lazy-route-error";
import { Page } from "~/components/page/Page";
import { DetailPagePending } from "~/components/route-pending";
import { pageTitle } from "~/lib/page-title";

/** Lazy: it pulls in the stock and discard dialogs, which almost no cold load needs. */
const ShelfTriageWorkbench = lazy(() =>
  import("~/app/inventory/triage/ShelfTriageWorkbench").then((m) => ({
    default: m.ShelfTriageWorkbench,
  })),
);

const searchSchema = z.object({
  // Narrow the pass to the products bought on one import run's purchases.
  run: runShortcode.optional().catch(undefined),
  // Bound the pass to the costly rows: a net-basis floor and/or one category.
  minSpend: z.coerce.number().positive().optional().catch(undefined),
  categoryId: productCategoryShortcode.optional().catch(undefined),
});

const searchDefaults = {
  run: undefined,
  minSpend: undefined,
  categoryId: undefined,
} as const;

export const Route = createFileRoute("/_authenticated/inventory/triage")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  component: ShelfTriagePage,
  head: () => ({ meta: [{ title: pageTitle("Shelf triage") }] }),
});

function ShelfTriagePage() {
  const { run, minSpend, categoryId } = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <Page
      variant="list"
      title="Shelf triage"
      eyebrow="Inventory"
      compact
      decoration="none"
    >
      <Suspense fallback={<SimpleLoading text="Loading shelf triage..." />}>
        <ShelfTriageWorkbench
          run={run}
          minSpend={minSpend}
          categoryId={categoryId}
          onBoundsChange={(bounds) =>
            void navigate({ search: (prev) => ({ ...prev, ...bounds }) })
          }
        />
      </Suspense>
    </Page>
  );
}
