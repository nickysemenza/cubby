import {
  createFileRoute,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { z } from "zod";

import { CreateDialogAction } from "~/app/_components/forms/create-dialog-action";
import { listPage } from "~/app/_components/routing/entity-routes";
import {
  expenseAnalyzeConfigFromSearch,
  expenseAnalyzeSearchFields,
  expenseAnalyzeSearchPatch,
} from "~/app/expenses/expense-analyze-config";
import { ExpenseList } from "~/app/expenses/expenselist";
import { Stack } from "~/components/layout";
import { Skeleton } from "~/components/ui/skeleton";
import {
  ViewSwitcher,
  type ViewSwitcherOption,
} from "~/components/ui/view-switcher";
import { expenseCaptureRequest } from "~/entities/editing/editor-requests";
import { ensureEntityListSsr } from "~/entities/entity-list-ssr";
import { entitySearch } from "~/entities/generated/entity-search.gen";
import { pageTitle } from "~/lib/page-title";

const EXPENSE_LIST_VIEWS = ["ledger", "analytics"] as const;

/**
 * The ledger's filter params are also what the Analytics view decodes back
 * out, so `expense.analytics` is always called with the exact filter set the
 * Ledger table shows. The transform canonicalizes the Analyze-only controls
 * so a shared URL and a freshly built one spell the same configuration.
 */
const expenseSearchSchema = z
  .object({
    ...entitySearch.expense.schema.shape,
    view: z.enum(EXPENSE_LIST_VIEWS).optional().catch(undefined),
    ...expenseAnalyzeSearchFields,
  })
  .transform(
    ({
      analyzeRows,
      analyzeColumns,
      analyzeMetric,
      analyzeCompare,
      analyzeShow,
      ...rest
    }) => {
      const analyzePatch = expenseAnalyzeSearchPatch(
        expenseAnalyzeConfigFromSearch({
          ...rest,
          analyzeRows,
          analyzeColumns,
          analyzeMetric,
          analyzeCompare,
          analyzeShow,
        }),
      );
      const canonicalAnalyzeSearch: Partial<typeof analyzePatch> = {};
      if (analyzePatch.analyzeRows !== undefined) {
        canonicalAnalyzeSearch.analyzeRows = analyzePatch.analyzeRows;
      }
      if (analyzePatch.analyzeColumns !== undefined) {
        canonicalAnalyzeSearch.analyzeColumns = analyzePatch.analyzeColumns;
      }
      if (analyzePatch.analyzeMetric !== undefined) {
        canonicalAnalyzeSearch.analyzeMetric = analyzePatch.analyzeMetric;
      }
      if (analyzePatch.analyzeCompare !== undefined) {
        canonicalAnalyzeSearch.analyzeCompare = analyzePatch.analyzeCompare;
      }
      if (analyzePatch.analyzeShow !== undefined) {
        canonicalAnalyzeSearch.analyzeShow = analyzePatch.analyzeShow;
      }
      return { ...rest, ...canonicalAnalyzeSearch };
    },
  );
const expenseSearchDefaults = {
  ...entitySearch.expense.defaults,
  view: undefined,
  analyzeRows: undefined,
  analyzeColumns: undefined,
  analyzeMetric: undefined,
  analyzeCompare: undefined,
  analyzeShow: undefined,
};

/**
 * The ledger preloader has no use for the selected renderer or Analyze-only
 * URL controls. Keep them outside its client-navigation loader payload: Start
 * serializes loader dependencies, while this route's transform intentionally
 * reintroduces those absent fields to normalize a shared URL.
 */
function expenseListLoaderDeps(search: z.output<typeof expenseSearchSchema>) {
  const {
    view,
    analyzeRows: _analyzeRows,
    analyzeColumns: _analyzeColumns,
    analyzeMetric: _analyzeMetric,
    analyzeCompare: _analyzeCompare,
    analyzeShow: _analyzeShow,
    ...listSearch
  } = search;
  return {
    active: (view ?? "ledger") === "ledger",
    search: listSearch,
  };
}

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
type ViewOption = (typeof EXPENSE_LIST_VIEWS)[number];

const VIEW_SWITCHER_OPTIONS: ViewSwitcherOption<ViewOption>[] = [
  { value: "ledger", label: "Ledger" },
  { value: "analytics", label: "Analytics" },
];

function useExpensesView(): ViewOption {
  const { view } = Route.useSearch();
  return view ?? "ledger";
}

function ExpensesListBody() {
  const view = useExpensesView();

  return (
    <Stack gap="md">
      {view === "ledger" && <ExpenseList />}

      {view === "analytics" && (
        <Suspense fallback={<Skeleton className="h-[400px] w-full" />}>
          <ExpenseAnalyticsView />
        </Suspense>
      )}
    </Stack>
  );
}

function ExpensesWorkbenchControls() {
  const view = useExpensesView();
  const navigate = useNavigate({ from: Route.fullPath });

  return (
    <ViewSwitcher
      ariaLabel="Expenses view"
      options={VIEW_SWITCHER_OPTIONS}
      value={view}
      onValueChange={(v) =>
        // Merge, don't replace: table-search/filter params survive a
        // renderer switch and stay shareable in the URL.
        navigate({ search: (prev) => ({ ...prev, view: v }) })
      }
    />
  );
}

function useExpensesBodyGutter(): "none" | "standard" {
  return useExpensesView() === "ledger" ? "none" : "standard";
}

// Bound to a const, not inlined into the options object: see the splitter
// note atop `entity-routes.tsx`.
const ExpensesPage = listPage({
  title: "Expenses",
  list: ExpensesListBody,
  workbenchControls: () => <ExpensesWorkbenchControls />,
  bodyGutter: useExpensesBodyGutter,
  actions: () => <CreateDialogAction request={expenseCaptureRequest()} />,
});

export const Route = createFileRoute("/_authenticated/expenses/")({
  validateSearch: expenseSearchSchema,
  search: { middlewares: [stripSearchParams(expenseSearchDefaults)] },
  loaderDeps: ({ search }) => expenseListLoaderDeps(search),
  loader: ({ context, deps, abortController }) =>
    ensureEntityListSsr({
      queryClient: context.queryClient,
      entity: "expense",
      search: deps.search,
      active: deps.active,
      signal: abortController.signal,
    }),
  component: ExpensesPage,
  head: () => ({ meta: [{ title: pageTitle("Expenses") }] }),
});
