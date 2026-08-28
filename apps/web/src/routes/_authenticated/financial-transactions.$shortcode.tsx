import { createFileRoute } from "@tanstack/react-router";

import { ensureDetailRecord } from "~/app/_components/routing/detail-loader";
import {
  detailPage,
  notFoundPage,
} from "~/app/_components/routing/entity-routes";
import { FinancialTransactionDetail } from "~/app/finance/financial-transaction-detail";
import { RouteErrorComponent } from "~/components/lazy-route-error";
import { DetailPagePending } from "~/components/route-pending";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import { shortcodeHead } from "~/lib/page-title";

// Bound to consts, not inlined into the options object: the router plugin's
// splitter re-parses an inlined call expression with a JSX-less babel config,
// so only the identifier path survives a page body that renders JSX.
const FinancialTransactionDetailPage = detailPage({
  query: (shortcode) =>
    entityDetailFor("financialTransaction").queryOptions(shortcode),
  render: (transaction) => (
    <FinancialTransactionDetail transaction={transaction} />
  ),
  title: (transaction) => transaction.merchant || transaction.rawDescription,
});

const FinancialTransactionNotFound = notFoundPage(
  "financialTransaction",
  "Transaction not found",
  "This transaction is no longer available.",
);

export const Route = createFileRoute(
  "/_authenticated/financial-transactions/$shortcode",
)({
  loader: ({ params, context }) =>
    ensureDetailRecord(
      context.queryClient,
      entityDetailFor("financialTransaction").queryOptions(params.shortcode),
    ),
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  notFoundComponent: FinancialTransactionNotFound,
  head: shortcodeHead,
  component: FinancialTransactionDetailPage,
});
