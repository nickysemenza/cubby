import { createFileRoute, stripSearchParams } from "@tanstack/react-router";

import { listPage } from "~/app/_components/routing/entity-routes";
import { LedgerTransferList } from "~/app/finance/ledger-transfer-list";
import { ensureEntityListSsr } from "~/entities/entity-list-ssr";
import {
  ledgerTransferSearchDefaults,
  ledgerTransferSearchSchema,
} from "~/entities/list-search";
import { pageTitle } from "~/lib/page-title";

// Bound to a const, not inlined into the options object: the router plugin's
// splitter re-parses an inlined call expression with a JSX-less babel config,
// so only the identifier path survives a page body that renders JSX.
const LedgerTransfersPage = listPage({
  title: "Transfers",
  entity: "ledgerTransfer",
  list: LedgerTransferList,
});

export const Route = createFileRoute("/_authenticated/ledger-transfers/")({
  validateSearch: ledgerTransferSearchSchema,
  search: { middlewares: [stripSearchParams(ledgerTransferSearchDefaults)] },
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps, abortController }) =>
    ensureEntityListSsr({
      queryClient: context.queryClient,
      entity: "ledgerTransfer",
      search: deps,
      signal: abortController.signal,
    }),
  head: () => ({ meta: [{ title: pageTitle("Transfers") }] }),
  component: LedgerTransfersPage,
});
