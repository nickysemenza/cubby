import { createFileRoute } from "@tanstack/react-router";

import { ensureDetailRecord } from "~/app/_components/routing/detail-loader";
import {
  detailPage,
  notFoundPage,
} from "~/app/_components/routing/entity-routes";
import { LedgerPartyDetail } from "~/app/finance/ledger-party-detail";
import { RouteErrorComponent } from "~/components/lazy-route-error";
import { DetailPagePending } from "~/components/route-pending";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import { shortcodeHead } from "~/lib/page-title";

// Bound to consts, not inlined into the options object: the router plugin's
// splitter re-parses an inlined call expression with a JSX-less babel config,
// so only the identifier path survives a page body that renders JSX.
const LedgerPartyDetailPage = detailPage({
  query: (shortcode) => entityDetailFor("ledgerParty").queryOptions(shortcode),
  render: (party) => <LedgerPartyDetail party={party} />,
  title: (party) => party.name,
});

const LedgerPartyNotFound = notFoundPage(
  "ledgerParty",
  "Ledger party not found",
  "It may have been deleted.",
);

export const Route = createFileRoute(
  "/_authenticated/ledger-parties/$shortcode",
)({
  loader: ({ params, context }) =>
    ensureDetailRecord(
      context.queryClient,
      entityDetailFor("ledgerParty").queryOptions(params.shortcode),
    ),
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  notFoundComponent: LedgerPartyNotFound,
  head: shortcodeHead,
  component: LedgerPartyDetailPage,
});
