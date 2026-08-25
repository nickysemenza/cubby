import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { CreateDialogAction } from "~/app/_components/forms/create-dialog-action";
import { listPage } from "~/app/_components/routing/entity-routes";
import { FinancialTransactionList } from "~/app/finance/financial-transaction-list";
import { financialTransactionCaptureRequest } from "~/entities/editing/editor-requests";
import { ensureEntityListSsr } from "~/entities/entity-list-ssr";
import {
  financeSearchDefaults,
  financialTransactionSearchSchema,
} from "~/entities/list-search";
import { pageTitle } from "~/lib/page-title";

// Bound to a const, not inlined into the options object: the router plugin's
// splitter re-parses an inlined call expression with a JSX-less babel config,
// so only the identifier path survives a page body that renders JSX.
const TransactionsPage = listPage({
  title: "Transactions",
  entity: "financialTransaction",
  list: FinancialTransactionList,
  actions: () => (
    <CreateDialogAction request={financialTransactionCaptureRequest()} />
  ),
});

export const Route = createFileRoute("/_authenticated/financial-transactions/")(
  {
    validateSearch: financialTransactionSearchSchema,
    search: { middlewares: [stripSearchParams(financeSearchDefaults)] },
    loaderDeps: ({ search }) => search,
    loader: ({ context, deps, abortController }) =>
      ensureEntityListSsr({
        queryClient: context.queryClient,
        entity: "financialTransaction",
        search: deps,
        signal: abortController.signal,
      }),
    head: () => ({ meta: [{ title: pageTitle("Transactions") }] }),
    component: TransactionsPage,
  },
);
