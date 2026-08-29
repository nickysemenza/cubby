import { createFileRoute, stripSearchParams } from "@tanstack/react-router";

import { listPage } from "~/app/_components/routing/entity-routes";
import { LedgerPartyList } from "~/app/finance/ledger-party-list";
import { ensureEntityListSsr } from "~/entities/entity-list-ssr";
import {
  ledgerPartySearchDefaults,
  ledgerPartySearchSchema,
} from "~/entities/list-search";
import { pageTitle } from "~/lib/page-title";

// Bound to a const, not inlined into the options object: the router plugin's
// splitter re-parses an inlined call expression with a JSX-less babel config,
// so only the identifier path survives a page body that renders JSX.
const LedgerPartiesPage = listPage({
  title: "Ledger Parties",
  entity: "ledgerParty",
  list: LedgerPartyList,
});

export const Route = createFileRoute("/_authenticated/ledger-parties/")({
  validateSearch: ledgerPartySearchSchema,
  search: { middlewares: [stripSearchParams(ledgerPartySearchDefaults)] },
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps, abortController }) =>
    ensureEntityListSsr({
      queryClient: context.queryClient,
      entity: "ledgerParty",
      search: deps,
      signal: abortController.signal,
    }),
  head: () => ({ meta: [{ title: pageTitle("Ledger Parties") }] }),
  component: LedgerPartiesPage,
});
