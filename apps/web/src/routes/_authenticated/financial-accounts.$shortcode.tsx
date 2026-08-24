import { createFileRoute } from "@tanstack/react-router";
import { ensureDetailRecord } from "~/app/_components/routing/detail-loader";
import {
  detailPage,
  notFoundPage,
} from "~/app/_components/routing/entity-routes";
import { FinancialAccountDetail } from "~/app/finance/financial-account-detail";
import { RouteErrorComponent } from "~/components/lazy-route-error";
import { DetailPagePending } from "~/components/route-pending";
import { shortcodeHead } from "~/lib/page-title";

// Bound to consts, not inlined into the options object: the router plugin's
// splitter re-parses an inlined call expression with a JSX-less babel config,
// so only the identifier path survives a page body that renders JSX.
const FinancialAccountDetailPage = detailPage({
  query: (api, shortcode) =>
    api.financialAccount.getByShortcode.queryOptions({ shortcode }),
  render: (account) => <FinancialAccountDetail account={account} />,
  title: (account) => account.name,
});

const FinancialAccountNotFound = notFoundPage(
  "financialAccount",
  "Account not found",
  "This financial account is no longer available.",
);

export const Route = createFileRoute(
  "/_authenticated/financial-accounts/$shortcode",
)({
  loader: ({ params, context }) =>
    ensureDetailRecord(
      context.queryClient,
      context.trpc.financialAccount.getByShortcode.queryOptions({
        shortcode: params.shortcode,
      }),
    ),
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  notFoundComponent: FinancialAccountNotFound,
  head: shortcodeHead,
  component: FinancialAccountDetailPage,
});
