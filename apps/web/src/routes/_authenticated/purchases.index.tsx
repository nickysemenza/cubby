import { costTypeSchema, tradeSchema } from "@cubby/schemas/project";
import {
  createFileRoute,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { z } from "zod";
import { tableSearchFields } from "~/app/_components/data-table/table-search";
import { CreatePurchaseDialog } from "~/app/purchases/create-purchase-dialog";
import { PurchaseActions } from "~/app/purchases/purchase-actions";
import { PurchaseList } from "~/app/purchases/purchaselist";
import { Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import { Skeleton } from "~/components/ui/skeleton";
import {
  ViewSwitcher,
  type ViewSwitcherOption,
} from "~/components/ui/view-switcher";

// The analytics view is entirely Nivo charts and its tab is unmounted until
// selected — lazy so the chart stack stays out of the default Ledger view.
const PurchaseAnalyticsView = lazy(() =>
  import("~/app/purchases/purchase-analytics-view").then((m) => ({
    default: m.PurchaseAnalyticsView,
  })),
);

const viewOptions = ["ledger", "planned", "analytics", "unclassified"] as const;
type ViewOption = (typeof viewOptions)[number];

const VIEW_SWITCHER_OPTIONS: ViewSwitcherOption<ViewOption>[] = [
  { value: "ledger", label: "Ledger" },
  { value: "planned", label: "Planned" },
  { value: "analytics", label: "Analytics" },
  { value: "unclassified", label: "Unclassified" },
];

// `trade`/`costType`/`project`/`future`/`date`/`productId`/`product` mirror
// the ledger table's own column-filter ids/values 1:1 (see
// `purchaseFiltersFromSearch` in purchase-options.ts) — the Ledger view
// live-syncs its filters here, and the Analytics view reads them straight off
// the URL, so `purchase.analytics` is always called with the exact filter set
// the Ledger table currently shows (the hard invariant the two endpoints
// share an input schema for). `productId` is the raw id for an exact-product
// deep link (e.g. from a product's "See all in ledger" link); `product` is
// the presence-column value ("has"/"none") from the header filter — they're
// deliberately separate keys since the product column's filter widget only
// offers presence, not a specific-product select (see `productLinkedOptions`).
const searchSchema = z.object({
  q: z.string().optional().catch(undefined),
  view: z.enum(viewOptions).optional().catch(undefined),
  trade: tradeSchema.optional().catch(undefined),
  costType: costTypeSchema.optional().catch(undefined),
  project: z.string().optional().catch(undefined),
  future: z.enum(["true", "false"]).optional().catch(undefined),
  date: z.string().optional().catch(undefined),
  productId: z.string().optional().catch(undefined),
  product: z.enum(["has", "none"]).optional().catch(undefined),
  // Quick-capture deep link (navbar "+" / command palette) — there is no
  // /purchases/new route, so the create dialog is opened by this param.
  create: z.boolean().optional().catch(undefined),
  ...tableSearchFields,
});

const searchDefaults = {
  q: undefined,
  view: undefined,
  trade: undefined,
  costType: undefined,
  project: undefined,
  future: undefined,
  date: undefined,
  productId: undefined,
  product: undefined,
  create: undefined,
} as const;

export const Route = createFileRoute("/_authenticated/purchases/")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  component: PurchasesPage,
  head: () => ({ meta: [{ title: "Purchases | cubby" }] }),
});

function PurchasesPage() {
  const search = Route.useSearch();
  const { q } = search;
  const view = search.view ?? "ledger";
  const navigate = useNavigate({ from: Route.fullPath });

  return (
    <Page
      variant="list"
      title="Purchases"
      fullWidth
      actions={<PurchaseActions />}
    >
      <Stack gap="md">
        <ViewSwitcher
          ariaLabel="Purchases view"
          options={VIEW_SWITCHER_OPTIONS}
          value={view}
          onValueChange={(v) =>
            // Merge, don't replace — a plain object here would drop `q` (and
            // any table-search/filter params) from the URL on every view switch.
            navigate({ search: (prev) => ({ ...prev, view: v }) })
          }
        />

        {view === "ledger" && <PurchaseList mode="ledger" initialSearch={q} />}

        {view === "planned" && (
          <PurchaseList mode="planned" initialSearch={q} />
        )}

        {view === "analytics" && (
          <Suspense fallback={<Skeleton className="h-[400px] w-full" />}>
            <PurchaseAnalyticsView />
          </Suspense>
        )}

        {view === "unclassified" && (
          <PurchaseList mode="unclassified" initialSearch={q} />
        )}
      </Stack>

      {/* Deep-linked quick capture: open state is read straight off the URL and
          cleared (replace) on close, so a refresh or back-nav can't reopen it. */}
      <CreatePurchaseDialog
        open={search.create === true}
        onOpenChange={(open) => {
          if (!open)
            navigate({
              search: (prev) => ({ ...prev, create: undefined }),
              replace: true,
            });
        }}
      />
    </Page>
  );
}
