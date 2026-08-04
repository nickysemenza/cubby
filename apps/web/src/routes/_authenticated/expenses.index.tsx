import {
  createFileRoute,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { z } from "zod";
import { tableSearchFields } from "~/app/_components/data-table/table-search";
import { CreateDialogAction } from "~/app/_components/forms/create-dialog-action";
import { CreateExpenseDialog } from "~/app/expenses/create-expense-dialog";
import { ExpenseList } from "~/app/expenses/expenselist";
import { Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import { Skeleton } from "~/components/ui/skeleton";
import {
  ViewSwitcher,
  type ViewSwitcherOption,
} from "~/components/ui/view-switcher";
import { entityFilterSearchFields } from "~/entities/filter-search-fields";
import { urlStringParam } from "~/lib/search-params";

// The analytics view is entirely Nivo charts and its tab is unmounted until
// selected — lazy so the chart stack stays out of the default Ledger view.
const ExpenseAnalyticsView = lazy(() =>
  import("~/app/expenses/expense-analytics-view").then((m) => ({
    default: m.ExpenseAnalyticsView,
  })),
);

// Only two entries left, and both are genuinely different RENDERERS. The
// former `planned` / `unclassified` / `unassigned` tabs were filter presets,
// which are now declarations in the view manifest and reachable from the
// table's own Views menu as ordinary, shareable URL state.
const viewOptions = ["ledger", "analytics"] as const;
type ViewOption = (typeof viewOptions)[number];

const VIEW_SWITCHER_OPTIONS: ViewSwitcherOption<ViewOption>[] = [
  { value: "ledger", label: "Ledger" },
  { value: "analytics", label: "Analytics" },
];

/**
 * Old bookmarks pointed at `?view=planned|unclassified|unassigned`. Those tabs
 * are gone; map each to the filter state its preset used to pin, so a stale
 * link lands on the same rows instead of a dead tab. Precedent:
 * `RecipeDetail.tsx`'s legacy-tab normalizer.
 */
const LEGACY_VIEW_FILTERS: Record<string, Record<string, string>> = {
  planned: { future: "true" },
  unassigned: { project: "__none__" },
  unclassified: { trade: "other", cost: "none" },
};

const isViewOption = (v: string | undefined): v is ViewOption =>
  v !== undefined && (viewOptions as readonly string[]).includes(v);

// The ledger's filter params come from the expense filter manifest, which is
// also what the table encodes into the URL and what the Analytics view decodes
// back out — so `expense.analytics` is always called with the exact filter
// set the Ledger table shows (the invariant the two endpoints share an input
// schema for). `productId` is the raw id for an exact-product deep link (from
// a product's "See all in ledger"); `product` is the presence value
// ("has"/"none"), deliberately a separate key since the product column's
// filter offers presence rather than a specific-product select.
const searchSchema = z
  .object({
    // Deliberately `string`, not `z.enum(viewOptions)`: a legacy `?view=planned`
    // must survive validation long enough for the transform below to translate
    // it. The transform is what narrows this to `ViewOption | undefined`.
    view: urlStringParam,
    // Spread first so ANY manifest spec survives this strict schema — a new
    // filter can't be silently stripped by being forgotten here. The keys read
    // by name in TS are then declared explicitly below, because a computed
    // Record has no literal key types for `Route.useSearch()` to expose.
    ...entityFilterSearchFields("expense"),
    // `urlStringParam`, NOT a bare `z.string()`: these sit AFTER the spread
    // and override it, so a plain string schema here would reinstate the
    // silently-dropped-value hole that schema exists to close (see its doc
    // comment). Three of these keys hit it in practice — `?q=486242` and
    // `?order=11334` parse as numbers, `?future=true` as a boolean.
    q: urlStringParam,
    trade: urlStringParam,
    costType: urlStringParam,
    lineKind: urlStringParam,
    cost: urlStringParam,
    project: urlStringParam,
    subprojects: urlStringParam,
    future: urlStringParam,
    date: urlStringParam,
    productId: urlStringParam,
    product: urlStringParam,
    // `order` (the manifest's `orderIdExact` url key) and `vendor` are set
    // together as a pair by the "Same Order" section and the ledger's Order #
    // cell — an order id only identifies an order within one vendor. Declared
    // by name so those `<Link search={{ order, vendor }}>` calls typecheck.
    order: urlStringParam,
    vendor: urlStringParam,
    orderId: urlStringParam,
    // Deep link from a charge's own detail page — the exact-charge scope,
    // same treatment as `productId` above.
    purchaseId: urlStringParam,
    // Quick-capture deep link (navbar "+" / command palette) — there is no
    // /expenses/new route, so the create dialog is opened by this param.
    create: z.boolean().optional().catch(undefined),
    ...tableSearchFields,
  })
  .transform(({ view, ...rest }) => {
    const legacy = view ? LEGACY_VIEW_FILTERS[view] : undefined;
    // A retired preset tab becomes the filter state it used to pin, so the
    // bookmark lands on the same rows — and now says so in the URL.
    if (legacy) return { ...rest, ...legacy, view: undefined };
    return {
      ...rest,
      view: isViewOption(view) ? view : undefined,
    };
  });

const searchDefaults = {
  q: undefined,
  view: undefined,
  cost: undefined,
  trade: undefined,
  costType: undefined,
  lineKind: undefined,
  project: undefined,
  subprojects: undefined,
  future: undefined,
  date: undefined,
  productId: undefined,
  product: undefined,
  order: undefined,
  vendor: undefined,
  orderId: undefined,
  purchaseId: undefined,
  create: undefined,
} as const;

export const Route = createFileRoute("/_authenticated/expenses/")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  component: ExpensesPage,
  head: () => ({ meta: [{ title: "Expenses | cubby" }] }),
});

function ExpensesPage() {
  const search = Route.useSearch();
  const view = search.view ?? "ledger";
  const navigate = useNavigate({ from: Route.fullPath });

  return (
    <Page
      variant="list"
      title="Expenses"
      fullWidth
      actions={<CreateDialogAction Dialog={CreateExpenseDialog} />}
    >
      <Stack gap="md">
        <ViewSwitcher
          ariaLabel="Expenses view"
          options={VIEW_SWITCHER_OPTIONS}
          value={view}
          onValueChange={(v) =>
            // Merge, don't replace — a plain object here would drop `q` (and
            // any table-search/filter params) from the URL on every view switch.
            navigate({ search: (prev) => ({ ...prev, view: v }) })
          }
        />

        {view === "ledger" && <ExpenseList />}

        {view === "analytics" && (
          <Suspense fallback={<Skeleton className="h-[400px] w-full" />}>
            <ExpenseAnalyticsView />
          </Suspense>
        )}
      </Stack>

      {/* Deep-linked quick capture: open state is read straight off the URL and
          cleared (replace) on close, so a refresh or back-nav can't reopen it. */}
      <CreateExpenseDialog
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
