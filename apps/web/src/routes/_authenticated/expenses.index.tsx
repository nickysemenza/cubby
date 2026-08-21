import {
  createFileRoute,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { z } from "zod";
import { tableSearchFields } from "~/app/_components/data-table/table-search";
import { CreateDialogAction } from "~/app/_components/forms/create-dialog-action";
import {
  expenseAnalyzeConfigFromSearch,
  expenseAnalyzeSearchFields,
  expenseAnalyzeSearchPatch,
} from "~/app/expenses/expense-analyze-config";
import { ExpenseList } from "~/app/expenses/expenselist";
import { Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import { Skeleton } from "~/components/ui/skeleton";
import {
  ViewSwitcher,
  type ViewSwitcherOption,
} from "~/components/ui/view-switcher";
import { expenseCaptureRequest } from "~/entities/editing";
import { entityFilterSearchFields } from "~/entities/filter-search-fields";
import { pageTitle } from "~/lib/page-title";
import {
  urlEnumListParam,
  urlShortcodeListParam,
  urlStringParam,
} from "~/lib/search-params";

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
export const expenseSearchSchema = z
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
    trade: urlEnumListParam(tradeSchema),
    costType: urlEnumListParam(costTypeSchema),
    lineKind: urlEnumListParam(expenseLineKindSchema),
    lineBasis: urlEnumListParam(expenseLineBasisSchema),
    cost: urlStringParam,
    project: urlShortcodeListParam("project"),
    subprojects: urlStringParam,
    future: urlEnumListParam(z.enum(["true", "false"])),
    date: urlStringParam,
    dateFrom: urlStringParam,
    dateTo: urlStringParam,
    productId: urlShortcodeListParam("product"),
    product: urlStringParam,
    // `order` (the manifest's `orderIdExact` url key) and `vendor` are set
    // together as a pair by the "Same Order" section and the ledger's Order #
    // cell — an order id only identifies an order within one vendor. Declared
    // by name so those `<Link search={{ order, vendor }}>` calls typecheck.
    order: urlStringParam,
    vendor: urlShortcodeListParam("vendor"),
    orderId: urlStringParam,
    // Deep link from a charge's own detail page — the exact-charge scope,
    // same treatment as `productId` above.
    purchaseId: urlStringParam,
    ...expenseAnalyzeSearchFields,
    // Quick-capture deep link (navbar "+" / command palette) — there is no
    // /expenses/new route, so the create dialog is opened by this param.
    create: z.boolean().optional().catch(undefined),
    ...tableSearchFields,
  })
  .transform(({ view, ...rest }) => {
    const legacy = view ? LEGACY_VIEW_FILTERS[view] : undefined;
    const normalizedRest = {
      ...rest,
      ...expenseAnalyzeSearchPatch(expenseAnalyzeConfigFromSearch(rest)),
    };
    // A retired preset tab becomes the filter state it used to pin, so the
    // bookmark lands on the same rows — and now says so in the URL.
    if (legacy) return { ...normalizedRest, ...legacy, view: undefined };
    return {
      ...normalizedRest,
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
  lineBasis: undefined,
  project: undefined,
  subprojects: undefined,
  future: undefined,
  date: undefined,
  dateFrom: undefined,
  dateTo: undefined,
  productId: undefined,
  product: undefined,
  order: undefined,
  vendor: undefined,
  orderId: undefined,
  purchaseId: undefined,
  analyzeRows: undefined,
  analyzeColumns: undefined,
  analyzeMetric: undefined,
  analyzeCompare: undefined,
  analyzeShow: undefined,
  create: undefined,
} as const;

export const Route = createFileRoute("/_authenticated/expenses/")({
  validateSearch: expenseSearchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  component: ExpensesPage,
  head: () => ({ meta: [{ title: pageTitle("Expenses") }] }),
});

function ExpensesPage() {
  const search = Route.useSearch();
  const view = search.view ?? "ledger";
  const navigate = useNavigate({ from: Route.fullPath });

  return (
    <Page
      variant="list"
      title="Expenses"
      layout="full"
      actions={<CreateDialogAction request={expenseCaptureRequest()} />}
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
    </Page>
  );
}

import {
  expenseLineBasisSchema,
  expenseLineKindSchema,
} from "@cubby/schemas/expense-line-kind";
import { costTypeSchema, tradeSchema } from "@cubby/schemas/project";
