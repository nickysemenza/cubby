import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { CreateDialogAction } from "~/app/_components/forms/create-dialog-action";
import { listPage } from "~/app/_components/routing/entity-routes";
import { VendorList } from "~/app/vendors/vendorlist";
import { vendorCaptureRequest } from "~/entities/editing/editor-requests";
import { ensureEntityListSsr } from "~/entities/entity-list-ssr";
import {
  vendorSearchDefaults,
  vendorSearchSchema,
} from "~/entities/list-search";
import { pageTitle } from "~/lib/page-title";

// Bound to a const, not inlined into the options object: the router plugin's
// splitter re-parses an inlined call expression with a JSX-less babel config,
// so only the identifier path survives a page body that renders JSX.
const VendorsPage = listPage({
  title: "Vendors",
  list: VendorList,
  actions: () => (
    <CreateDialogAction request={vendorCaptureRequest()}>
      New Vendor
    </CreateDialogAction>
  ),
});

export const Route = createFileRoute("/_authenticated/vendors/")({
  validateSearch: vendorSearchSchema,
  search: { middlewares: [stripSearchParams(vendorSearchDefaults)] },
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) =>
    ensureEntityListSsr({
      queryClient: context.queryClient,
      entity: "vendor",
      search: deps,
    }),
  head: () => ({ meta: [{ title: pageTitle("Vendors") }] }),
  component: VendorsPage,
});
