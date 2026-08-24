import { createFileRoute } from "@tanstack/react-router";
import { ensureDetailRecord } from "~/app/_components/routing/detail-loader";
import {
  detailPage,
  notFoundPage,
} from "~/app/_components/routing/entity-routes";
import { ExpenseDetail } from "~/app/expenses/expense-detail";
import { RouteErrorComponent } from "~/components/lazy-route-error";
import { DetailPagePending } from "~/components/route-pending";
import { entityDetailQueryOptions } from "~/entities/entity-detail";
import { shortcodeHead } from "~/lib/page-title";

// Bound to consts, not inlined into the options object: the router plugin's
// splitter re-parses an inlined call expression with a JSX-less babel config,
// so only the identifier path survives a page body that renders JSX.
const ExpenseDetailPage = detailPage({
  query: (shortcode) => entityDetailQueryOptions("expense", shortcode),
  render: (expense, shortcode) => (
    <ExpenseDetail key={shortcode} expense={expense} />
  ),
  title: (expense) => expense.name,
});

const ExpenseNotFound = notFoundPage(
  "expense",
  "Expense not found",
  "This expense is no longer available.",
);

export const Route = createFileRoute("/_authenticated/expenses/$shortcode")({
  loader: ({ params, context }) =>
    ensureDetailRecord(
      context.queryClient,
      entityDetailQueryOptions("expense", params.shortcode),
    ),
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  notFoundComponent: ExpenseNotFound,
  head: shortcodeHead,
  component: ExpenseDetailPage,
});
