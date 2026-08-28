import { createFileRoute, stripSearchParams } from "@tanstack/react-router";

import { CreateDialogAction } from "~/app/_components/forms/create-dialog-action";
import { listPage } from "~/app/_components/routing/entity-routes";
import { PurchaseList } from "~/app/purchases/purchaselist";
import { purchaseCaptureRequest } from "~/entities/editing/editor-requests";
import { ensureEntityListSsr } from "~/entities/entity-list-ssr";
import {
  purchaseSearchDefaults,
  purchaseSearchSchema,
} from "~/entities/list-search";
import { pageTitle } from "~/lib/page-title";

// Bound to a const, not inlined into the options object: the router plugin's
// splitter re-parses an inlined call expression with a JSX-less babel config,
// so only the identifier path survives a page body that renders JSX.
const PurchasesPage = listPage({
  title: "Purchases",
  list: PurchaseList,
  actions: () => <CreateDialogAction request={purchaseCaptureRequest()} />,
});

export const Route = createFileRoute("/_authenticated/purchases/")({
  validateSearch: purchaseSearchSchema,
  search: { middlewares: [stripSearchParams(purchaseSearchDefaults)] },
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps, abortController }) =>
    ensureEntityListSsr({
      queryClient: context.queryClient,
      entity: "purchase",
      search: deps,
      signal: abortController.signal,
    }),
  head: () => ({ meta: [{ title: pageTitle("Purchases") }] }),
  component: PurchasesPage,
});
