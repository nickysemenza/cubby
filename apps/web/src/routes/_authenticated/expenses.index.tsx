import {
  createFileRoute,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { CreateDialogAction } from "~/app/_components/forms/create-dialog-action";
import { ExpenseList } from "~/app/expenses/expenselist";
import { Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import { Skeleton } from "~/components/ui/skeleton";
import {
  ViewSwitcher,
  type ViewSwitcherOption,
} from "~/components/ui/view-switcher";
import { expenseCaptureRequest } from "~/entities/editing/editor-requests";
import {
  type EXPENSE_LIST_VIEWS,
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

export const Route = createFileRoute("/_authenticated/expenses/")({
  validateSearch: expenseSearchSchema,
  search: { middlewares: [stripSearchParams(expenseSearchDefaults)] },
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
      listChrome="workbench"
      title="Expenses"
      layout="full"
      actions={<CreateDialogAction request={expenseCaptureRequest()} />}
      workbenchControls={
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
      }
    >
      <Stack gap="md">
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
