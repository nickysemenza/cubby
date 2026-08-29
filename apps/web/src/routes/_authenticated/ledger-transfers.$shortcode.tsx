import { createFileRoute } from "@tanstack/react-router";

import { ensureDetailRecord } from "~/app/_components/routing/detail-loader";
import {
  detailPage,
  notFoundPage,
} from "~/app/_components/routing/entity-routes";
import { LedgerTransferDetail } from "~/app/finance/ledger-transfer-detail";
import { RouteErrorComponent } from "~/components/lazy-route-error";
import { DetailPagePending } from "~/components/route-pending";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import { shortcodeHead } from "~/lib/page-title";
import { formatCurrency } from "~/lib/utils";

// Bound to consts, not inlined into the options object: the router plugin's
// splitter re-parses an inlined call expression with a JSX-less babel config,
// so only the identifier path survives a page body that renders JSX.
const LedgerTransferDetailPage = detailPage({
  query: (shortcode) =>
    entityDetailFor("ledgerTransfer").queryOptions(shortcode),
  render: (transfer) => <LedgerTransferDetail transfer={transfer} />,
  title: (transfer) => `${formatCurrency(transfer.amount)} transfer`,
});

const LedgerTransferNotFound = notFoundPage(
  "ledgerTransfer",
  "Transfer not found",
  "It may have been deleted.",
);

export const Route = createFileRoute(
  "/_authenticated/ledger-transfers/$shortcode",
)({
  loader: ({ params, context }) =>
    ensureDetailRecord(
      context.queryClient,
      entityDetailFor("ledgerTransfer").queryOptions(params.shortcode),
    ),
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  notFoundComponent: LedgerTransferNotFound,
  head: shortcodeHead,
  component: LedgerTransferDetailPage,
});
