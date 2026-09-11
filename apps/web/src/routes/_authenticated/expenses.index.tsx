import {
  createFileRoute,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { lazy, Suspense } from "react";

import { CreateDialogAction } from "~/app/_components/forms/create-dialog-action";
import { listPage } from "~/app/_components/routing/entity-routes";
import { ExpenseList } from "~/app/expenses/expenselist";
import { Stack } from "~/components/layout";
import { Skeleton } from "~/components/ui/skeleton";
import {
  ViewSwitcher,
  type ViewSwitcherOption,
} from "~/components/ui/view-switcher";
import { expenseCaptureRequest } from "~/entities/editing/editor-requests";
import { ensureEntityListSsr } from "~/entities/entity-list-ssr";
import {
  type EXPENSE_LIST_VIEWS,
  expenseListLoaderDeps,
  expenseSearchDefaults,
  expenseSearchSchema,
} from "~/entities/list-search";
import { pageTitle } from "~/lib/page-title";

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
