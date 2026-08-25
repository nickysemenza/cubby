import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { CreateDialogAction } from "~/app/_components/forms/create-dialog-action";
import { listPage } from "~/app/_components/routing/entity-routes";
import { FinancialAccountList } from "~/app/finance/financial-account-list";
import { financialAccountCaptureRequest } from "~/entities/editing/editor-requests";
import { ensureEntityListSsr } from "~/entities/entity-list-ssr";
import {
  financeSearchDefaults,
  financialAccountSearchSchema,
} from "~/entities/list-search";
import { pageTitle } from "~/lib/page-title";

// Bound to a const, not inlined into the options object: the router plugin's
// splitter re-parses an inlined call expression with a JSX-less babel config,
// so only the identifier path survives a page body that renders JSX.
const AccountsPage = listPage({
  title: "Accounts",
  entity: "financialAccount",
  list: FinancialAccountList,
  actions: () => (
    <CreateDialogAction request={financialAccountCaptureRequest()} />
  ),
});

export const Route = createFileRoute("/_authenticated/financial-accounts/")({
  validateSearch: financialAccountSearchSchema,
  search: { middlewares: [stripSearchParams(financeSearchDefaults)] },
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps, abortController }) =>
    ensureEntityListSsr({
      queryClient: context.queryClient,
      entity: "financialAccount",
      search: deps,
      signal: abortController.signal,
    }),
  head: () => ({ meta: [{ title: pageTitle("Accounts") }] }),
  component: AccountsPage,
});
