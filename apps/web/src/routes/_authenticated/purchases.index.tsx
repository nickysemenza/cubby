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
import { entityFilterSearchFields } from "~/entities/filter-manifest";

// The analytics view is entirely Nivo charts and its tab is unmounted until
// selected — lazy so the chart stack stays out of the default Ledger view.
const PurchaseAnalyticsView = lazy(() =>
  import("~/app/purchases/purchase-analytics-view").then((m) => ({
    default: m.PurchaseAnalyticsView,
  })),
);

const viewOptions = [
  "ledger",
  "planned",
  "analytics",
  "unclassified",
  "unassigned",
] as const;
type ViewOption = (typeof viewOptions)[number];

const VIEW_SWITCHER_OPTIONS: ViewSwitcherOption<ViewOption>[] = [
  { value: "ledger", label: "Ledger" },
  { value: "planned", label: "Planned" },
  { value: "analytics", label: "Analytics" },
  { value: "unclassified", label: "Unclassified" },
  { value: "unassigned", label: "Unassigned" },
];

// The ledger's filter params come from the purchase filter manifest, which is
// also what the table encodes into the URL and what the Analytics view decodes
// back out — so `purchase.analytics` is always called with the exact filter
// set the Ledger table shows (the invariant the two endpoints share an input
// schema for). `productId` is the raw id for an exact-product deep link (from
// a product's "See all in ledger"); `product` is the presence value
// ("has"/"none"), deliberately a separate key since the product column's
// filter offers presence rather than a specific-product select.
const searchSchema = z.object({
  view: z.enum(viewOptions).optional().catch(undefined),
  // Spread first so ANY manifest spec survives this strict schema — a new
  // filter can't be silently stripped by being forgotten here. The keys read
  // by name in TS are then declared explicitly below, because a computed
  // Record has no literal key types for `Route.useSearch()` to expose.
  ...entityFilterSearchFields("purchase"),
  q: z.string().optional().catch(undefined),
  trade: z.string().optional().catch(undefined),
  costType: z.string().optional().catch(undefined),
  project: z.string().optional().catch(undefined),
  future: z.string().optional().catch(undefined),
  date: z.string().optional().catch(undefined),
  productId: z.string().optional().catch(undefined),
  product: z.string().optional().catch(undefined),
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

        {view === "unassigned" && (
          <PurchaseList mode="unassigned" initialSearch={q} />
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
